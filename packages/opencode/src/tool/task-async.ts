import * as Tool from "./tool"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { canDelegateTasks } from "../agent/subagent-permissions"
import { InstanceStore } from "@/project/instance-store"
import { Permission } from "../permission"
import { Database } from "@opencode-ai/core/database/database"
import { Deferred, Effect, Option, Schema, Scope } from "effect"
import { getBatch, getTaskMeta, registerBatch, registerTask, type TaskMeta } from "./task-registry"
import { taskModel, taskPromptWithContext, type TaskPromptOps } from "./task"
import { TaskContext } from "./task-context"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

const TASK_RESULT_LIMIT = 6000
const WAIT_TIMEOUT_SECONDS = 600

const StatusParameters = Schema.Struct({
  task_id: Schema.optional(Schema.String).annotate({
    description: "Child session id (task_id) to inspect",
  }),
  batch_id: Schema.optional(Schema.String).annotate({
    description: "Batch id returned when multiple background tasks were launched together",
  }),
  include_output: Schema.optional(Schema.Boolean).annotate({
    description: "When task_id is set, include last assistant text (default true). Ignored for list views.",
  }),
})

const WaitParameters = Schema.Struct({
  task_id: Schema.optional(Schema.String).annotate({
    description: "Single child session id to wait for",
  }),
  task_ids: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Multiple child session ids to wait for",
  }),
  batch_id: Schema.optional(Schema.String).annotate({
    description: "Wait for every task registered under this batch_id",
  }),
  wait_for: Schema.optional(Schema.Literals(["all", "any"])).annotate({
    description: "Wait until all targets finish (default) or until any one finishes",
  }),
  timeout_seconds: Schema.optional(Schema.Number).annotate({
    description: `Max seconds to wait (default ${WAIT_TIMEOUT_SECONDS})`,
  }),
  interval_seconds: Schema.optional(Schema.Number).annotate({
    description: "Unused; waits use BackgroundJob Deferreds, not polling intervals",
  }),
  include_output: Schema.optional(Schema.Boolean).annotate({
    description: "When true, append last assistant text for completed targets",
  }),
})

const AbortParameters = Schema.Struct({
  task_id: Schema.String.annotate({
    description: "Child session id of the running async task to abort",
  }),
})

const FollowupParameters = Schema.Struct({
  task_id: Schema.String.annotate({
    description: "Owned child session to continue or steer while running. The correction is admitted immediately.",
  }),
  prompt: Schema.String.annotate({
    description: "Follow-up instruction for the existing child session",
  }),
  title: Schema.optional(Schema.String).annotate({
    description: "Short title for this follow-up run",
  }),
  agent: Schema.optional(Schema.String).annotate({
    description: "Omit or repeat the child session agent. Switching agents on a follow-up is rejected.",
  }),
  allow_nested_tasks: Schema.optional(Schema.Boolean).annotate({
    description: "Reserved; nested task permission is owned by session rules",
  }),
  system: Schema.optional(Schema.String).annotate({
    description: "Optional system text prepended to the follow-up prompt",
  }),
})

type WaitRow = {
  id: string
  title: string
  status: string
  output?: string
  timedOut?: boolean
  /** 父会话新 prompt 协作式释放，任务本身仍在运行。 */
  released?: boolean
}

function clip(value: string, limit: number) {
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}\n... (truncated, ${value.length - limit} chars omitted)`
}

function jobStatus(job: BackgroundJob.Info | undefined) {
  if (job) return job.status
  return "idle"
}

function isPendingState(state: string) {
  return state === "running"
}

function requirePromptOps(ctx: Tool.Context) {
  const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
  if (!ops) return Effect.fail(new Error("task management tools require promptOps in ctx.extra"))
  return Effect.succeed(ops)
}

function resolveSessionID(taskId: string) {
  return SessionID.make(taskId)
}

function resolveTargets(params: { task_id?: string; task_ids?: readonly string[] }) {
  if (params.task_ids && params.task_ids.length > 0) return [...params.task_ids]
  if (params.task_id) return [params.task_id]
  return [] as string[]
}

const resolveBatchTargets = Effect.fnUntraced(function* (
  batchId: string,
  parentSessionId: SessionID,
  sessions: Session.Interface,
) {
  const cached = getBatch(batchId)
  if (cached && cached.length > 0) return [...cached]

  // 进程重启会清空内存索引，工具结果中的批次元数据是持久化恢复源。
  const messages = yield* sessions.messages({ sessionID: parentSessionId })
  const taskIds = [
    ...new Set(
      messages.flatMap((message) =>
        message.parts.flatMap((part) => {
            if (part.type !== "tool" || part.tool !== "task") {
            return []
          }
          if (!("metadata" in part.state) || part.state.metadata?.batchID !== batchId) return []
          const ids = part.state.metadata.taskIDs
          if (!Array.isArray(ids)) return []
          return ids.filter((id): id is string => typeof id === "string")
        }),
      ),
    ),
  ]
  if (taskIds.length > 0) registerBatch(batchId, taskIds)
  return taskIds
})

function messageText(msg: SessionV1.WithParts) {
  return msg.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim()
}

function assistantOutput(messages: SessionV1.WithParts[]) {
  const assistant = [...messages].reverse().find((entry) => entry.info.role === "assistant")
  if (!assistant || assistant.info.role !== "assistant") return "No assistant result yet."
  if (assistant.info.error) {
    const error = assistant.info.error
    if (error && typeof error === "object" && "data" in error) {
      const data = (error as { data?: { message?: string } }).data
      if (typeof data?.message === "string") return clip(`error: ${data.message}`, TASK_RESULT_LIMIT)
    }
    return clip(`error: ${String(error)}`, TASK_RESULT_LIMIT)
  }
  return clip(messageText(assistant) || "No assistant result yet.", TASK_RESULT_LIMIT)
}

function formatWaitSummary(completed: WaitRow[], pending: WaitRow[], timedOut: boolean, released: boolean) {
  return [
    `completed: ${completed.length}`,
    `pending: ${pending.length}`,
    `timed_out: ${timedOut}`,
    `released: ${released}`,
    ...(released
      ? [
          "wait stopped: a new user message arrived while tasks were still running",
          "tasks continue in the background; use task_status / task_wait again if needed",
        ]
      : []),
    ...completed.map((row) => `done ${row.id} | ${row.status} | ${row.title}`),
    ...pending.map((row) => `pending ${row.id} | ${row.status} | ${row.title}`),
  ]
}

function result(title: string, output: string, metadata: Record<string, unknown> = {}) {
  return { title, output, metadata }
}

export const TaskStatusTool = Tool.define(
  "task_status",
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const sessions = yield* Session.Service

    return {
      description: [
        "Read async child-session task status.",
        "Pass task_id for one task (optional last assistant output), batch_id for a registered batch,",
        "or omit both to list Session.children of the current session with BackgroundJob status.",
        "Launch work with the native task tool (async by default); use task_wait / abort / followup to manage it.",
      ].join(" "),
      parameters: StatusParameters,
      execute: (params: Schema.Schema.Type<typeof StatusParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (params.batch_id) {
            const ids = yield* resolveBatchTargets(params.batch_id, ctx.sessionID, sessions)
            if (ids.length === 0) {
              return result(`batch ${params.batch_id}`, `No async tasks found for batch_id: ${params.batch_id}`, {
                batch_id: params.batch_id,
                count: 0,
              })
            }

            const lines = yield* Effect.forEach(ids, (id) =>
              Effect.gen(function* () {
                const sessionID = resolveSessionID(id)
                const job = yield* background.get(id)
                const meta = getTaskMeta(id)
                const session = yield* sessions.get(sessionID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
                return `${id} | ${jobStatus(job)} | ${meta?.title ?? session?.title ?? "(untitled)"}`
              }),
            )
            return result(`batch ${params.batch_id}`, lines.join("\n"), {
              batch_id: params.batch_id,
              count: lines.length,
            })
          }

          if (!params.task_id) {
            const children = yield* sessions.children(ctx.sessionID)
            if (children.length === 0) {
              return result("async tasks", "No async child tasks for this session.", { count: 0 })
            }
            const lines = yield* Effect.forEach(children, (child) =>
              Effect.gen(function* () {
                const job = yield* background.get(child.id)
                const meta = getTaskMeta(child.id)
                return `${child.id} | ${jobStatus(job)} | ${meta?.title ?? child.title}`
              }),
            )
            return result("async tasks", lines.join("\n"), { count: lines.length })
          }

          const sessionID = resolveSessionID(params.task_id)
          const session = yield* sessions.get(sessionID)
          if (session.parentID && session.parentID !== ctx.sessionID) {
            return yield* Effect.fail(new Error("task_id is not a child of the current session"))
          }
          const job = yield* background.get(params.task_id)
          const meta = getTaskMeta(params.task_id)
          const state = jobStatus(job)
          const lines = [
            `task_id: ${params.task_id}`,
            `session_id: ${session.id}`,
            `title: ${meta?.title ?? session.title}`,
            `status: ${state}`,
            ...(job?.error ? [`error: ${job.error}`] : []),
          ]
          const includeOutput = params.include_output !== false
          if (!includeOutput) {
            return result(meta?.title ?? session.title, lines.join("\n"), {
              task_id: params.task_id,
              status: state,
            })
          }
          if (job?.output) {
            return result(
              meta?.title ?? session.title,
              `${lines.join("\n")}\n\ntask_result:\n${clip(job.output, TASK_RESULT_LIMIT)}`,
              { task_id: params.task_id, status: state },
            )
          }
          const messages = yield* sessions.messages({ sessionID })
          return result(
            meta?.title ?? session.title,
            `${lines.join("\n")}\n\ntask_result:\n${assistantOutput(messages)}`,
            { task_id: params.task_id, status: state },
          )
        }).pipe(Effect.orDie),
    }
  }),
)

export const TaskWaitTool = Tool.define(
  "task_wait",
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const sessions = yield* Session.Service
    const runState = yield* SessionRunState.Service

    // 统一终态快照：仅仍 running 的行可标 released/timedOut，避免 completed+pending 矛盾。
    const snapshotRow = Effect.fn("TaskWait.snapshotRow")(function* (
      id: string,
      includeOutput: boolean,
      flags?: { timedOut?: boolean; released?: boolean },
    ) {
      const meta = getTaskMeta(id)
      const sessionID = resolveSessionID(id)
      const session = yield* sessions.get(sessionID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      const title = meta?.title ?? session?.title ?? id
      const job = yield* background.get(id)
      if (!job) {
        const messages = includeOutput ? yield* sessions.messages({ sessionID }) : []
        return {
          id,
          title,
          status: "completed",
          output: includeOutput ? assistantOutput(messages) : undefined,
        } satisfies WaitRow
      }
      if (job.status !== "running") {
        const output = includeOutput
          ? job.output
            ? clip(job.output, TASK_RESULT_LIMIT)
            : yield* sessions.messages({ sessionID }).pipe(
                Effect.map(assistantOutput),
                Effect.catchCause(() => Effect.succeed(undefined)),
              )
          : undefined
        return {
          id,
          title: job.title ?? title,
          status: job.status,
          output,
        } satisfies WaitRow
      }
      return {
        id,
        title: job.title ?? title,
        status: "running",
        timedOut: flags?.timedOut === true ? true : undefined,
        released: flags?.released === true ? true : undefined,
      } satisfies WaitRow
    })

    // 单任务完成 effect：不参与 release race；all/any 外层只 race 一次会话 release。
    const awaitJobDone = Effect.fn("TaskWait.awaitJobDone")(function* (id: string) {
      const job = yield* background.get(id)
      if (!job || job.status !== "running") return
      yield* background.wait({ id }).pipe(Effect.asVoid)
    })

    return {
      description: [
        "Wait until one or more async child-session tasks finish.",
        "Pass task_id, task_ids, or batch_id. Uses BackgroundJob.wait (Effect Deferred), not shell sleep.",
        "Default wait_for=all; timeout_seconds defaults to 600.",
        "A new user message in this session cooperatively stops the wait (tasks keep running).",
      ].join(" "),
      parameters: WaitParameters,
      execute: (params: Schema.Schema.Type<typeof WaitParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const targets = params.batch_id
            ? yield* resolveBatchTargets(params.batch_id, ctx.sessionID, sessions)
            : resolveTargets(params)
          if (targets.length === 0) {
            return result("wait", "No async tasks found to wait for.", { count: 0 })
          }

          for (const id of targets) {
            const session = yield* sessions
              .get(resolveSessionID(id))
              .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
            if (session?.parentID && session.parentID !== ctx.sessionID) {
              return yield* Effect.fail(new Error(`task_id ${id} is not a child of the current session`))
            }
          }

          const waitFor = params.wait_for ?? "all"
          const timeoutMs = (params.timeout_seconds ?? WAIT_TIMEOUT_SECONDS) * 1000
          const includeOutput = params.include_output === true

          // 先原子注册再 await：同 callID 的 sticky 覆盖 pre-register 窗口；
          // register 后 onUserPrompt 唤醒 active waiter。注册完成写 metadata 供 readiness。
          const registration = yield* runState.registerWait(ctx.sessionID, ctx.callID)
          type WaitKind = "done" | "released" | "timeout"

          const jobsDone =
            waitFor === "any"
              ? Effect.raceAll(targets.map((id) => awaitJobDone(id)))
              : Effect.forEach(targets, (id) => awaitJobDone(id), {
                  concurrency: "unbounded",
                  discard: true,
                })

          const outcome = yield* Effect.gen(function* () {
            yield* ctx.metadata({
              title: "wait",
              metadata: { waiting: true, registered: true },
            })
            return yield* Effect.raceFirst(
              jobsDone.pipe(Effect.as("done" as const)),
              Deferred.await(registration.released).pipe(Effect.as("released" as const)),
            ).pipe(
              Effect.timeoutOption(timeoutMs),
              Effect.map((opt): WaitKind => (Option.isNone(opt) ? "timeout" : opt.value)),
            )
          }).pipe(Effect.ensuring(runState.unregisterWait(ctx.sessionID, registration.token)))

          const completed: WaitRow[] = []
          const pending: WaitRow[] = []
          const releaseWon = outcome === "released"
          const timeoutWon = outcome === "timeout"

          for (const id of targets) {
            const row = yield* snapshotRow(id, includeOutput, {
              released: releaseWon || undefined,
              timedOut: timeoutWon || undefined,
            })
            if (isPendingState(row.status)) pending.push(row)
            else completed.push(row)
          }

          const released = pending.some((row) => row.released === true)
          const timedOut = pending.some((row) => row.timedOut === true)
          const lines = formatWaitSummary(completed, pending, timedOut, released)
          if (includeOutput) {
            for (const row of completed) {
              if (!row.output) continue
              lines.push("", `result ${row.id}:`, row.output)
            }
          }
          return result("wait", lines.join("\n"), {
            completed: completed.length,
            pending: pending.length,
            timed_out: timedOut,
            released,
            task_ids: targets,
          })
        }).pipe(Effect.orDie),
    }
  }),
)

export const TaskAbortTool = Tool.define(
  "task_abort",
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const sessions = yield* Session.Service
    const store = yield* InstanceStore.Service

    return {
      description:
        "Abort a running async child task by task_id (child session id). Cancels BackgroundJob and the session run via promptOps.cancel.",
      parameters: AbortParameters,
      execute: (params: Schema.Schema.Type<typeof AbortParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const sessionID = resolveSessionID(params.task_id)
          const session = yield* sessions.get(sessionID)
          if (session.parentID !== ctx.sessionID) {
            return yield* Effect.fail(new Error("task_id is not a child of the current session"))
          }
          const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
          yield* background.cancel(params.task_id)
          if (ops) yield* store.provide({ directory: session.directory }, ops.cancel(sessionID))
          return result(`abort ${params.task_id}`, `Aborted async task: ${params.task_id}`, {
            task_id: params.task_id,
            session_id: session.id,
          })
        }).pipe(Effect.orDie),
    }
  }),
)

export const TaskFollowupTool = Tool.define(
  "task_followup",
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const database = yield* Database.Service
    const store = yield* InstanceStore.Service

    return {
      description: [
        "Continue an existing async child session without clearing its context.",
        "Running tasks receive the correction immediately for the next safe provider-turn boundary; idle tasks resume in the background.",
        "use task_wait or task_status for the result. Keeps the child's agent, model, project, and permissions; agent overrides are rejected.",
      ].join(" "),
      parameters: FollowupParameters,
      execute: (params: Schema.Schema.Type<typeof FollowupParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ops = yield* requirePromptOps(ctx)
          const sessionID = resolveSessionID(params.task_id)
          const child = yield* sessions.get(sessionID)
          if (child.parentID !== ctx.sessionID) {
            return yield* Effect.fail(new Error("task_id is not a child of the current session"))
          }
          const parent = yield* sessions.get(ctx.sessionID)
          if (
            Permission.evaluate("task_followup", child.agent ?? "*", parent.permission ?? []).action === "deny"
          ) {
            return yield* Effect.fail(new Error("Session permission denies task_followup"))
          }

          const existingJob = yield* background.get(params.task_id)

          const agentName = child.agent
          if (!agentName) return yield* Effect.fail(new Error("Follow-up requires an agent name"))
          if (params.agent && params.agent !== agentName) {
            return yield* Effect.fail(
              new Error(`Cannot switch task agent from ${agentName}; create a new task instead`),
            )
          }
          const next = yield* store.provide({ directory: child.directory }, agent.get(agentName))
          if (!next) return yield* Effect.fail(new Error(`Unknown agent type: ${agentName}`))

          const title = params.title?.trim() || `follow-up: ${child.title}`
          const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
            Effect.provideService(Database.Service, database),
            Effect.orDie,
          )
          if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))

          const model = taskModel({ session: child, agent: next, parent: msg.info })
          const variant = msg.info.variant
          const openProjectDirectories = ctx.extra?.openProjectDirectories as readonly string[] | undefined
          const promptText = taskPromptWithContext({
            prompt: params.system ? `${params.system}\n\n${params.prompt}` : params.prompt,
            allowNestedTasks: canDelegateTasks(next, child.permission ?? []),
          })
          const context = yield* TaskContext.prepare(sessions, ctx)
          const admitted = yield* store.provide(
            { directory: child.directory },
            Effect.gen(function* () {
              const parts = yield* ops.resolvePromptParts(promptText)
              return yield* ops.admit({
                messageID: MessageID.ascending(),
                sessionID: child.id,
                model: { modelID: model.id, providerID: model.providerID },
                variant: model.variant,
                agent: next.name,
                parts: TaskContext.attach(parts, context),
                openProjectDirectories,
              })
            }),
          )

          const metadata = {
            parentSessionId: ctx.sessionID,
            sessionId: child.id,
            model: { modelID: model.id, providerID: model.providerID },
            agent: next.name,
            directory: child.directory,
            background: true,
            followup: true,
            context: context.summary,
            delivery: {
              type: existingJob?.status === "running" ? "steer" : "followup",
              state: "admitted",
              messageID: admitted.info.id,
            },
          }

          yield* ctx.metadata({
            title,
            metadata,
          })

          // 续跑必须重建子项目上下文，不能借父项目的代理配置或文件权限执行。
          const runTask = Effect.fn("TaskFollowup.runTask")(function* () {
            return yield* store.provide(
              { directory: child.directory },
              Effect.gen(function* () {
                const resultText = yield* ops.resume(child.id)
                return resultText.parts
                  .filter((item) => item.type === "text")
                  .map((item) => item.text)
                  .join("\n\n")
              }),
            )
          })

          const inject = Effect.fn("TaskFollowup.inject")(function* (state: "completed" | "error", text: string) {
            const currentParent = yield* sessions.get(ctx.sessionID)
            yield* ops
              .prompt({
                sessionID: ctx.sessionID,
                agent: currentParent.agent ?? ctx.agent,
                variant,
                openProjectDirectories,
                parts: [
                  {
                    type: "text",
                    synthetic: true,
                    text: [
                      `<task id="${child.id}" state="${state}">`,
                      `<summary>Background follow-up ${state}: ${title}</summary>`,
                      state === "error" ? "<task_error>" : "<task_result>",
                      text,
                      state === "error" ? "</task_error>" : "</task_result>",
                      "</task>",
                    ].join("\n"),
                  },
                ],
              })
              .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
          })

          const notify = Effect.fn("TaskFollowup.notify")(function* (jobID: string) {
            yield* background.wait({ id: jobID }).pipe(
              Effect.flatMap((waited) => {
                if (waited.info?.status === "completed") return inject("completed", waited.info.output ?? "")
                if (waited.info?.status === "error") return inject("error", waited.info.error ?? "")
                return Effect.void
              }),
              Effect.forkIn(scope, { startImmediately: true }),
            )
          })

          const meta: TaskMeta = {
            title,
            parentSessionId: ctx.sessionID,
            createdAt: Date.now(),
            agent: next.name,
            batchId: getTaskMeta(child.id)?.batchId,
          }

          if (yield* background.extend({ id: child.id, run: runTask() })) {
            registerTask(child.id, meta)
            return result(
              title,
              [
                "Started async follow-up in the existing session.",
                `task_id: ${child.id}`,
                `session_id: ${child.id}`,
                `title: ${title}`,
                `agent: ${next.name}`,
                "status: accepted (extended running job)",
              ].join("\n"),
              { ...metadata, jobId: child.id },
            )
          }

          if (yield* background.extend({ id: child.id, run: runTask() })) {
            return {
              title,
              metadata,
              output: `Correction admitted to task_id: ${child.id}\nmessage_id: ${admitted.info.id}\nApplies at the next safe provider-turn boundary. Already executed tools are not undone. The existing task will notify on completion.`,
            }
          }
          const info = yield* background.start({
            id: child.id,
            type: "task",
            title,
            metadata,
            onPromote: Effect.all([
              ctx.metadata({
                title,
                metadata: { ...metadata, jobId: child.id },
              }),
              notify(child.id),
            ]),
            run: runTask().pipe(
              Effect.onInterrupt(() => store.provide({ directory: child.directory }, ops.cancel(child.id))),
            ),
          })

          yield* notify(info.id)
          registerTask(child.id, meta)

          return result(
            title,
            [
              "Started async follow-up in the existing session.",
              `task_id: ${child.id}`,
              `session_id: ${child.id}`,
              `title: ${title}`,
              `agent: ${next.name}`,
              "status: accepted",
            ].join("\n"),
            { ...metadata, jobId: info.id },
          )
        }).pipe(Effect.orDie),
    }
  }),
)
