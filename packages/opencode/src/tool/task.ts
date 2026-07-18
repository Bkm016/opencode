import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import {
  deriveSubagentSessionPermission,
  ORCHESTRATION_TOOLS,
} from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { Effect, Exit, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { Database } from "@opencode-ai/core/database/database"
import { createBatchID, registerBatch, registerTask } from "./task-registry"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts>
}

const id = "task"
const MAX_BATCH = 20
const CONTEXT_MESSAGE_LIMIT = 12
const CONTEXT_CHAR_LIMIT = 16_000
const CONTEXT_TOOL_OUTPUT_LIMIT = 1200

const BACKGROUND_STARTED = [
  "The task is working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
].join("\n")

const BACKGROUND_UPDATED = [
  "Additional context sent to the running background task.",
  "The task is still working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you sent and end your response.",
].join("\n")

export const TaskEntry = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.optional(Schema.String).annotate({
    description: "The type of specialized agent to use for this task",
  }),
  agent: Schema.optional(Schema.String).annotate({
    description: "Alias for subagent_type",
  }),
  title: Schema.optional(Schema.String).annotate({
    description: "Optional short session title; falls back to description",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
  inherit_context: Schema.optional(Schema.Boolean).annotate({
    description: "When true, prepend recent parent transcript into the child prompt. Default false",
  }),
  allow_nested_tasks: Schema.optional(Schema.Boolean).annotate({
    description: "When true, allow the child to call task tools. Default false",
  }),
})

export const Parameters = Schema.Struct({
  description: Schema.optional(Schema.String).annotate({
    description: "A short (3-5 words) description of the task (required unless tasks is set)",
  }),
  prompt: Schema.optional(Schema.String).annotate({
    description: "The task for the agent to perform (required unless tasks is set)",
  }),
  subagent_type: Schema.optional(Schema.String).annotate({
    description: "The type of specialized agent to use (required unless set per tasks entry)",
  }),
  agent: Schema.optional(Schema.String).annotate({
    description: "Alias for subagent_type",
  }),
  title: Schema.optional(Schema.String).annotate({
    description: "Optional short session title; falls back to description",
  }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
  inherit_context: Schema.optional(Schema.Boolean).annotate({
    description: "When true, prepend recent parent transcript into the child prompt. Default false",
  }),
  allow_nested_tasks: Schema.optional(Schema.Boolean).annotate({
    description: "When true, allow the child to call task tools. Default false",
  }),
  wait: Schema.optional(Schema.Boolean).annotate({
    description:
      "When true, block until the task completes and return its result. Default false (async). Prefer this for rare foreground cases.",
  }),
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Deprecated alias: background=false is equivalent to wait=true. Async is the default; omit this field for async launch.",
  }),
  tasks: Schema.optional(Schema.Array(TaskEntry)).annotate({
    description:
      "Launch multiple child tasks in parallel (max 20). When set, top-level description/prompt are optional defaults are not required.",
  }),
})

type TaskParams = Schema.Schema.Type<typeof Parameters>
type TaskEntryParams = Schema.Schema.Type<typeof TaskEntry>
type ConfigShape = {
  subagent_depth?: number
  experimental?: { primary_tools?: string[] }
}

type ResolvedEntry = {
  description: string
  prompt: string
  subagent_type: string
  title: string
  command?: string
  inherit_context: boolean
  allow_nested_tasks: boolean
  task_id?: string
}

export function renderOutput(input: {
  sessionID: SessionID
  state: "running" | "completed" | "error"
  summary?: string
  text: string
}) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

function clip(value: string, limit: number) {
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}\n... (truncated, ${value.length - limit} chars omitted)`
}

function formatContextMessage(entry: SessionV1.WithParts) {
  const role = entry.info.role
  const chunks = entry.parts.flatMap((part) => {
    if (part.type === "text") {
      const text = part.text.trim()
      return text ? [text] : []
    }
    if (part.type === "tool") {
      const toolName = part.tool
      if (ORCHESTRATION_TOOLS.includes(toolName as (typeof ORCHESTRATION_TOOLS)[number])) return []
      if (part.state.status === "completed") {
        const title = typeof part.state.title === "string" ? ` ${part.state.title}` : ""
        const output = clip(String(part.state.output ?? ""), CONTEXT_TOOL_OUTPUT_LIMIT).trim()
        return output ? [`[tool ${toolName}${title}]\n${output}`] : []
      }
      if (part.state.status === "error") {
        return [`[tool ${toolName} error]\n${String(part.state.error ?? "")}`]
      }
    }
    if (part.type === "patch" && Array.isArray(part.files)) {
      return [`[patch]\n${part.files.map(String).join("\n")}`]
    }
    return []
  })
  const text = chunks.join("\n\n").trim()
  return text ? `${role}:\n${text}` : ""
}

export function loadInheritedContext(messages: SessionV1.WithParts[]) {
  const context = messages
    .slice(-CONTEXT_MESSAGE_LIMIT)
    .map(formatContextMessage)
    .filter(Boolean)
    .join("\n\n")
  return context ? clip(context, CONTEXT_CHAR_LIMIT) : undefined
}

export function taskPromptWithContext(input: {
  prompt: string
  command?: string
  inheritedContext?: string
  allowNestedTasks: boolean
}) {
  const body = input.command ? `Triggered by command: ${input.command}\n\n${input.prompt}` : input.prompt
  const delegation = input.allowNestedTasks
    ? "Nested delegation is enabled for this task. You may use task when independent work should be delegated; wait for and integrate child results before finishing."
    : "Nested delegation is disabled for this task. Complete the work yourself and do not attempt to call task/task_async."
  if (!input.inheritedContext) return [delegation, body].join("\n\n")
  return [
    delegation,
    "Parent session context (recent transcript, clipped):",
    "<parent_context>",
    input.inheritedContext,
    "</parent_context>",
    "The parent context is read-only background. Do not repeat parent orchestration and do not call task unless Nested delegation is enabled above.",
    "Task:",
    body,
  ].join("\n\n")
}

function shouldWait(params: TaskParams) {
  if (params.wait === true) return true
  if (params.background === false) return true
  if (params.wait === false) return false
  if (params.background === true) return false
  // Slash-command / command-triggered subtasks still need a blocking result.
  if (params.command) return true
  return false
}

function resolveEntries(params: TaskParams): ResolvedEntry[] {
  if (params.tasks && params.tasks.length > 0) {
    if (params.tasks.length > MAX_BATCH) {
      throw new Error(`tasks supports at most ${MAX_BATCH} entries`)
    }
    return params.tasks.map((entry) => resolveEntry(entry, params, false))
  }

  if (!params.description || !params.prompt) {
    throw new Error("task requires either tasks: [{ description, prompt, ... }] or description + prompt")
  }

  return [
    resolveEntry(
      {
        description: params.description,
        prompt: params.prompt,
        subagent_type: params.subagent_type,
        agent: params.agent,
        title: params.title,
        command: params.command,
        inherit_context: params.inherit_context,
        allow_nested_tasks: params.allow_nested_tasks,
      },
      params,
      true,
    ),
  ]
}

function resolveEntry(entry: TaskEntryParams, params: TaskParams, single: boolean): ResolvedEntry {
  const subagent_type = entry.subagent_type ?? entry.agent ?? params.subagent_type ?? params.agent
  if (!subagent_type) {
    throw new Error("task requires subagent_type (or agent) on the entry or top-level args")
  }
  const description = entry.description
  return {
    description,
    prompt: entry.prompt,
    subagent_type,
    title: (entry.title ?? params.title ?? description).replace(/\s+/g, " ").trim(),
    command: entry.command ?? (single ? params.command : undefined),
    inherit_context: entry.inherit_context ?? params.inherit_context ?? false,
    allow_nested_tasks: entry.allow_nested_tasks ?? params.allow_nested_tasks ?? false,
    task_id: single ? params.task_id : undefined,
  }
}

function childToolDenies(input: {
  subagent: Agent.Info
  allowNestedTasks: boolean
  primaryTools?: string[]
}) {
  const denies: { permission: string; pattern: "*"; action: "deny" }[] = []
  if (!input.subagent.permission.some((rule) => rule.permission === "todowrite")) {
    denies.push({ permission: "todowrite", pattern: "*", action: "deny" })
  }
  if (!input.allowNestedTasks) {
    for (const permission of ORCHESTRATION_TOOLS) {
      if (input.subagent.permission.some((rule) => rule.permission === permission)) continue
      denies.push({ permission, pattern: "*", action: "deny" })
    }
  }
  for (const permission of input.primaryTools ?? []) {
    denies.push({ permission, pattern: "*", action: "deny" })
  }
  return denies
}

function filterNestedTaskDenies(
  rules: ReturnType<typeof deriveSubagentSessionPermission>,
  allowNestedTasks: boolean,
) {
  if (!allowNestedTasks) return rules
  return rules.filter(
    (rule) =>
      !(rule.action === "deny" && ORCHESTRATION_TOOLS.includes(rule.permission as (typeof ORCHESTRATION_TOOLS)[number])),
  )
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const database = yield* Database.Service

    const runOne = Effect.fn("TaskTool.runOne")(function* (input: {
      entry: ResolvedEntry
      ctx: Tool.Context
      parent: Session.Info
      cfg: ConfigShape
      variant: string | undefined
      inheritedContext: string | undefined
      wait: boolean
      batchId?: string
    }) {
      const { entry, ctx, parent, cfg, variant, wait, batchId } = input
      const next = yield* agent.get(entry.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${entry.subagent_type} is not a valid agent type`))
      }

      const existing = entry.task_id
        ? yield* sessions.get(SessionID.make(entry.task_id)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined

      const childPermission = filterNestedTaskDenies(
        deriveSubagentSessionPermission({
          parentSessionPermission: parent.permission ?? [],
          subagent: next,
        }),
        entry.allow_nested_tasks,
      )
      const denies = childToolDenies({
        subagent: next,
        allowNestedTasks: entry.allow_nested_tasks,
        primaryTools: cfg.experimental?.primary_tools,
      })
      const nextSession =
        existing ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: entry.title + ` (@${next.name} subagent)`,
          agent: next.name,
          permission: [
            ...childPermission,
            ...denies.filter(
              (deny) =>
                !childPermission.some(
                  (rule) =>
                    rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === deny.action,
                ),
            ),
          ],
        }))

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const resolvedModel = next.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }

      const metadata: Record<string, unknown> = {
        parentSessionId: ctx.sessionID,
        sessionId: nextSession.id,
        model: resolvedModel,
        agent: next.name,
        title: entry.description,
        description: entry.description,
      }
      if (!wait) metadata.background = true
      if (batchId) metadata.batchId = batchId

      registerTask(nextSession.id, {
        title: entry.description,
        parentSessionId: ctx.sessionID,
        createdAt: Date.now(),
        agent: next.name,
        batchId,
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

      const promptText = taskPromptWithContext({
        prompt: entry.prompt,
        command: entry.command,
        inheritedContext: entry.inherit_context ? input.inheritedContext : undefined,
        allowNestedTasks: entry.allow_nested_tasks,
      })

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        const parts = yield* ops.resolvePromptParts(promptText)
        const result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: nextSession.id,
          model: {
            modelID: resolvedModel.modelID,
            providerID: resolvedModel.providerID,
          },
          variant: next.model ? undefined : variant,
          agent: next.name,
          parts,
        })
        return result.parts.findLast((item) => item.type === "text")?.text ?? ""
      })

      const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
        state: "completed" | "error",
        text: string,
      ) {
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
                text: renderOutput({
                  sessionID: nextSession.id,
                  state,
                  summary:
                    state === "completed"
                      ? `Background task completed: ${entry.description}`
                      : `Background task failed: ${entry.description}`,
                  text,
                }),
              },
            ],
          })
          .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      })

      const notify = Effect.fn("TaskTool.notifyBackgroundResult")(function* (jobID: string) {
        yield* background.wait({ id: jobID }).pipe(
          Effect.flatMap((result) => {
            if (result.info?.status === "completed") return inject("completed", result.info.output ?? "")
            if (result.info?.status === "error") return inject("error", result.info.error ?? "")
            return Effect.void
          }),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      })

      if (yield* background.extend({ id: nextSession.id, run: runTask() })) {
        return {
          title: entry.description,
          agent: next.name,
          sessionID: nextSession.id,
          metadata: {
            ...metadata,
            background: true,
            jobId: nextSession.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task updated",
            text: BACKGROUND_UPDATED,
          }),
          async: true as const,
        }
      }

      const info = yield* background.start({
        id: nextSession.id,
        type: id,
        title: entry.description,
        metadata,
        onPromote: Effect.all([
          ctx.metadata({
            title: entry.description,
            metadata: { ...metadata, background: true, jobId: nextSession.id },
          }),
          notify(nextSession.id),
        ]),
        run: runTask().pipe(Effect.onInterrupt(() => ops.cancel(nextSession.id))),
      })

      function backgroundResult() {
        return {
          title: entry.description,
          agent: next.name,
          sessionID: nextSession.id,
          metadata: {
            ...metadata,
            background: true,
            jobId: info.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task started",
            text: BACKGROUND_STARTED,
          }),
          async: true as const,
        }
      }

      if (!wait) {
        yield* notify(info.id)
        return backgroundResult()
      }

      const runCancel = yield* EffectBridge.make()
      const cancel = ops.cancel(nextSession.id)

      function onAbort() {
        runCancel.fork(cancel)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", onAbort)
        }),
        () =>
          Effect.gen(function* () {
            const result = yield* Effect.raceFirst(
              background.wait({ id: nextSession.id }).pipe(Effect.map((waited) => waited.info)),
              background.waitForPromotion(nextSession.id),
            )
            if (result?.metadata?.background === true) return backgroundResult()
            if (result?.status === "error") return yield* Effect.fail(new Error(result.error ?? "Task failed"))
            if (result?.status === "cancelled") return yield* Effect.fail(new Error("Task cancelled"))
            return {
              title: entry.description,
              agent: next.name,
              sessionID: nextSession.id,
              metadata,
              output: renderOutput({ sessionID: nextSession.id, state: "completed", text: result?.output ?? "" }),
              async: false as const,
            }
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit))
              yield* Effect.all([cancel, background.cancel(nextSession.id)], { discard: true })
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                ctx.abort.removeEventListener("abort", onAbort)
              }),
            ),
          ),
      )
    })

    const run = Effect.fn("TaskTool.execute")(function* (params: TaskParams, ctx: Tool.Context) {
      const cfg = (yield* config.get()) as ConfigShape
      const wait = shouldWait(params)
      const entries = resolveEntries(params)

      const parent = yield* sessions.get(ctx.sessionID)
      let current = parent
      let depth = 0
      while (current.parentID) {
        depth++
        current = yield* sessions.get(current.parentID)
      }
      if (depth >= (cfg.subagent_depth ?? 1)) {
        return yield* Effect.fail(
          new Error(
            `Subagent depth limit reached (${cfg.subagent_depth ?? 1}). Increase "subagent_depth" to allow nested subagents.`,
          ),
        )
      }

      if (!ctx.extra?.bypassAgentCheck) {
        const types = [...new Set(entries.map((entry) => entry.subagent_type))]
        for (const subagent_type of types) {
          yield* ctx.ask({
            permission: id,
            patterns: [subagent_type],
            always: ["*"],
            metadata: {
              description: entries.map((entry) => entry.description).join(", "),
              subagent_type,
            },
          })
        }
      }

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const variant = msg.info.variant

      const needsContext = entries.some((entry) => entry.inherit_context)
      const inheritedContext = needsContext ? loadInheritedContext(ctx.messages) : undefined

      const isBatch = Boolean(params.tasks && params.tasks.length > 0) || entries.length > 1

      if (isBatch) {
        const batchID = createBatchID()
        const launched = yield* Effect.all(
          entries.map((entry) =>
            runOne({
              entry,
              ctx,
              parent,
              cfg,
              variant,
              inheritedContext,
              wait,
              batchId: batchID,
            }),
          ),
          { concurrency: "unbounded" },
        )
        registerBatch(
          batchID,
          launched.map((item) => item.sessionID),
        )
        const tasks = launched.map((item) => ({
          sessionId: item.sessionID,
          title: item.title,
          agent: item.agent,
        }))
        const meta: Record<string, unknown> = {
          batchID,
          count: launched.length,
          taskIDs: launched.map((item) => item.sessionID),
          tasks,
          // Primary child for single-click; batch UI prefers tasks[].
          sessionId: launched[0]?.sessionID,
          background: !wait,
        }
        yield* ctx.metadata({
          title: `task: ${launched.length} sessions`,
          metadata: meta,
        })
        const lines = [
          `Started child sessions: ${launched.length}`,
          `batch_id: ${batchID}`,
          `wait: ${wait}`,
          `inherit_context: ${needsContext}`,
          `allow_nested_tasks: ${entries.some((entry) => entry.allow_nested_tasks)}`,
          ...launched.map(
            (item, index) =>
              `${index + 1}. ${item.sessionID} | session ${item.sessionID} | ${item.title} (${item.agent})`,
          ),
          wait ? "status: completed (waited)" : "status: accepted (async)",
          "You will be notified when async tasks finish. Use batch_id with task_async_status / task_async_wait when available.",
        ]
        return {
          title: `task: ${launched.length} sessions`,
          metadata: meta,
          output: lines.join("\n"),
        }
      }

      const entry = entries[0]!
      yield* ctx.metadata({
        title: entry.description,
        metadata: {
          parentSessionId: ctx.sessionID,
          agent: entry.subagent_type,
          title: entry.description,
          description: entry.description,
          ...(wait ? {} : { background: true }),
        },
      })

      const result = yield* runOne({
        entry,
        ctx,
        parent,
        cfg,
        variant,
        inheritedContext,
        wait,
      })

      return {
        title: result.title,
        metadata: result.metadata as Record<string, unknown>,
        output: result.output,
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: TaskParams, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie) as Effect.Effect<Tool.ExecuteResult>,
    }
  }),
)

export { createBatchID, getBatch, listBatches, registerBatch, registerTask, getTaskMeta } from "./task-registry"
