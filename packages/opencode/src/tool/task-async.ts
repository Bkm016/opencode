import * as Tool from "./tool"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { Database } from "@opencode-ai/core/database/database"
import { Effect, Option, Schema, Scope } from "effect"
import { getBatch, getTaskMeta, registerBatch, registerTask, type TaskMeta } from "./task-registry"
import type { TaskPromptOps } from "./task"
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
    description: "Child session id to resume with a new prompt (must be idle)",
  }),
  prompt: Schema.String.annotate({
    description: "Follow-up instruction for the existing child session",
  }),
  title: Schema.optional(Schema.String).annotate({
    description: "Short title for this follow-up run",
  }),
  agent: Schema.optional(Schema.String).annotate({
    description: "Agent name override; defaults to the child session agent",
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
  if (!ops) return Effect.fail(new Error("task_async tools require promptOps in ctx.extra"))
  return Effect.succeed(ops)
}

function resolveSessionID(taskId: string) {
  return SessionID.make(taskId)
}

function resolveTargets(params: {
  task_id?: string
  task_ids?: readonly string[]
}) {
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
          if (part.type !== "tool" || (part.tool !== "task" && part.tool !== "task_async")) return []
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

function formatWaitSummary(completed: WaitRow[], pending: WaitRow[], timedOut: boolean) {
  return [
    `completed: ${completed.length}`,
    `pending: ${pending.length}`,
    `timed_out: ${timedOut}`,
    ...completed.map((row) => `done ${row.id} | ${row.status} | ${row.title}`),
    ...pending.map((row) => `pending ${row.id} | ${row.status} | ${row.title}`),
  ]
}

function result(title: string, output: string, metadata: Record<string, unknown> = {}) {
  return { title, output, metadata }
}

export const TaskAsyncStatusTool = Tool.define(
  "task_async_status",
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const sessions = yield* Session.Service

    return {
      description: [
        "Read async child-session task status.",
        "Pass task_id for one task (optional last assistant output), batch_id for a registered batch,",
        "or omit both to list Session.children of the current session with BackgroundJob status.",
        "Launch work with the native task tool (async by default); use task_async_wait / abort / followup to manage it.",
      ].join(" "),
      parameters: StatusParameters,
      execute: (params: Schema.Schema.Type<typeof StatusParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (params.batch_id) {
            const ids = yield* resolveBatchTargets(params.batch_id, ctx.sessionID, sessions)
            if (ids.length === 0) {
              return result(
                `batch ${params.batch_id}`,
                `No async tasks found for batch_id: ${params.batch_id}`,
                { batch_id: params.batch_id, count: 0 },
              )
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

export const TaskAsyncWaitTool = Tool.define(
  "task_async_wait",
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const sessions = yield* Session.Service

    const waitOne = Effect.fn("TaskAsyncWait.waitOne")(function* (
      id: string,
      timeoutMs: number,
      includeOutput: boolean,
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

      const waited = yield* background.wait({ id, timeout: timeoutMs })
      if (waited.timedOut) {
        return {
          id,
          title: waited.info?.title ?? title,
          status: waited.info?.status ?? "running",
          timedOut: true,
        } satisfies WaitRow
      }

      const info = waited.info
      const output = includeOutput
        ? info?.output
          ? clip(info.output, TASK_RESULT_LIMIT)
          : yield* sessions.messages({ sessionID }).pipe(
              Effect.map(assistantOutput),
              Effect.catchCause(() => Effect.succeed(undefined)),
            )
        : undefined
      return {
        id,
        title: info?.title ?? title,
        status: info?.status ?? "completed",
        output,
      } satisfies WaitRow
    })

    return {
      description: [
        "Wait until one or more async child-session tasks finish.",
        "Pass task_id, task_ids, or batch_id. Uses BackgroundJob.wait (Effect Deferred), not shell sleep.",
        "Default wait_for=all; timeout_seconds defaults to 600.",
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
            const session = yield* sessions.get(resolveSessionID(id)).pipe(
              Effect.catchCause(() => Effect.succeed(undefined)),
            )
            if (session?.parentID && session.parentID !== ctx.sessionID) {
              return yield* Effect.fail(new Error(`task_id ${id} is not a child of the current session`))
            }
          }

          const waitFor = params.wait_for ?? "all"
          const timeoutMs = (params.timeout_seconds ?? WAIT_TIMEOUT_SECONDS) * 1000
          const includeOutput = params.include_output === true
          const completed: WaitRow[] = []
          const pending: WaitRow[] = []

          if (waitFor === "any") {
            // First real completion wins; overall timeout covers the race.
            const raced = yield* Effect.raceAll(
              targets.map((id) =>
                waitOne(id, timeoutMs, includeOutput).pipe(
                  Effect.filterOrFail(
                    (row) => !row.timedOut && !isPendingState(row.status),
                    () => new Error("pending"),
                  ),
                ),
              ),
            ).pipe(Effect.timeoutOption(timeoutMs))

            if (Option.isNone(raced)) {
              for (const id of targets) {
                const job = yield* background.get(id)
                const meta = getTaskMeta(id)
                const session = yield* sessions.get(resolveSessionID(id)).pipe(
                  Effect.catchCause(() => Effect.succeed(undefined)),
                )
                pending.push({
                  id,
                  title: meta?.title ?? session?.title ?? id,
                  status: jobStatus(job),
                  timedOut: true,
                })
              }
            } else {
              completed.push(raced.value)
              for (const id of targets) {
                if (id === raced.value.id) continue
                const job = yield* background.get(id)
                const meta = getTaskMeta(id)
                const session = yield* sessions.get(resolveSessionID(id)).pipe(
                  Effect.catchCause(() => Effect.succeed(undefined)),
                )
                const title = meta?.title ?? session?.title ?? id
                const state = jobStatus(job)
                if (isPendingState(state)) pending.push({ id, title, status: state })
                else completed.push({ id, title, status: state })
              }
            }
          } else {
            const rows = yield* Effect.forEach(
              targets,
              (id) => waitOne(id, timeoutMs, includeOutput),
              { concurrency: "unbounded" },
            )
            for (const row of rows) {
              if (row.timedOut || isPendingState(row.status)) pending.push(row)
              else completed.push(row)
            }
          }

          const timedOut = pending.some((row) => row.timedOut) || (waitFor === "all" && pending.length > 0)
          const lines = formatWaitSummary(completed, pending, timedOut)
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
            task_ids: targets,
          })
        }).pipe(Effect.orDie),
    }
  }),
)

export const TaskAsyncAbortTool = Tool.define(
  "task_async_abort",
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const sessions = yield* Session.Service

    return {
      description:
        "Abort a running async child task by task_id (child session id). Cancels BackgroundJob and the session run via promptOps.cancel.",
      parameters: AbortParameters,
      execute: (params: Schema.Schema.Type<typeof AbortParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const sessionID = resolveSessionID(params.task_id)
          const session = yield* sessions.get(sessionID)
          if (session.parentID && session.parentID !== ctx.sessionID) {
            return yield* Effect.fail(new Error("task_id is not a child of the current session"))
          }
          const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
          yield* background.cancel(params.task_id)
          if (ops) yield* ops.cancel(sessionID)
          return result(`abort ${params.task_id}`, `Aborted async task: ${params.task_id}`, {
            task_id: params.task_id,
            session_id: session.id,
          })
        }).pipe(Effect.orDie),
    }
  }),
)

export const TaskAsyncFollowupTool = Tool.define(
  "task_async_followup",
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const database = yield* Database.Service

    return {
      description: [
        "Continue an existing async child session without clearing its context.",
        "Session must be idle (no running BackgroundJob). Launches in the background and returns immediately;",
        "use task_async_wait or task_async_status for the result. Same task_id / session is reused.",
      ].join(" "),
      parameters: FollowupParameters,
      execute: (params: Schema.Schema.Type<typeof FollowupParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ops = yield* requirePromptOps(ctx)
          const sessionID = resolveSessionID(params.task_id)
          const child = yield* sessions.get(sessionID)
          if (child.parentID && child.parentID !== ctx.sessionID) {
            return yield* Effect.fail(new Error("task_id is not a child of the current session"))
          }

          const existingJob = yield* background.get(params.task_id)
          if (existingJob?.status === "running") {
            return yield* Effect.fail(
              new Error(
                "Async task session is still running; wait for completion or abort it before sending a follow-up",
              ),
            )
          }

          const agentName = params.agent ?? child.agent
          if (!agentName) return yield* Effect.fail(new Error("Follow-up requires an agent name"))
          const next = yield* agent.get(agentName)
          if (!next) return yield* Effect.fail(new Error(`Unknown agent type: ${agentName}`))

          const title = params.title?.trim() || `follow-up: ${child.title}`
          const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
            Effect.provideService(Database.Service, database),
            Effect.orDie,
          )
          if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))

          const model = next.model ?? {
            modelID: msg.info.modelID,
            providerID: msg.info.providerID,
          }
          const variant = msg.info.variant
          const promptText = params.system ? `${params.system}\n\n${params.prompt}` : params.prompt

          const metadata = {
            parentSessionId: ctx.sessionID,
            sessionId: child.id,
            model,
            background: true,
            followup: true,
          }

          yield* ctx.metadata({
            title,
            metadata,
          })

          const runTask = Effect.fn("TaskAsyncFollowup.runTask")(function* () {
            const parts = yield* ops.resolvePromptParts(promptText)
            const resultText = yield* ops.prompt({
              messageID: MessageID.ascending(),
              sessionID: child.id,
              model: {
                modelID: model.modelID,
                providerID: model.providerID,
              },
              variant: next.model ? undefined : variant,
              agent: next.name,
              parts,
            })
            return resultText.parts.findLast((item) => item.type === "text")?.text ?? ""
          })

          const inject = Effect.fn("TaskAsyncFollowup.inject")(function* (state: "completed" | "error", text: string) {
            const currentParent = yield* sessions.get(ctx.sessionID)
            yield* ops
              .prompt({
                sessionID: ctx.sessionID,
                agent: currentParent.agent ?? ctx.agent,
                variant,
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

          const notify = Effect.fn("TaskAsyncFollowup.notify")(function* (jobID: string) {
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
            run: runTask().pipe(Effect.onInterrupt(() => ops.cancel(child.id))),
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
