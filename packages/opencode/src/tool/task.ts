import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import PROJECT_TASK_DESCRIPTION from "./project-task.txt"
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
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceStore } from "@/project/instance-store"
import type { InstanceContext } from "@/project/instance-context"
import { createBatchID, registerBatch, registerTask } from "./task-registry"
import path from "node:path"

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
    : "Nested delegation is disabled for this task. Complete the work yourself and do not attempt to call task/task_async/project_task."
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

export function resolveOpenedProject(selector: string, loaded: readonly InstanceContext[]) {
  const value = selector.trim()
  if (!value) throw new Error("project_task requires a non-empty project selector")

  const exact = loaded.filter((ctx) => sameDirectory(ctx.directory, value))
  if (exact.length === 1) return exact[0]!

  const normalized = value.toLowerCase()
  const matches = loaded.filter((ctx) =>
    [path.basename(ctx.directory), path.basename(ctx.worktree), ctx.project.name]
      .filter((candidate): candidate is string => Boolean(candidate))
      .some((candidate) => candidate.toLowerCase() === normalized),
  )
  if (matches.length === 1) return matches[0]!

  const candidates = loaded.map((ctx) => `${ctx.project.name ?? path.basename(ctx.directory)} (${ctx.directory})`)
  if (matches.length > 1) {
    throw new Error(`project_task selector is ambiguous: ${selector}. Matches: ${matches.map((ctx) => ctx.directory).join(", ")}`)
  }
  throw new Error(
    `project_task can only use projects currently open in OpenCode. No open project matches: ${selector}.${candidates.length > 0 ? ` Open projects: ${candidates.join(", ")}` : " No projects are currently open."}`,
  )
}

function sameDirectory(a: string, b: string) {
  const left = FSUtil.resolve(a)
  const right = FSUtil.resolve(b)
  if (process.platform === "win32") return left.toLowerCase() === right.toLowerCase()
  return left === right
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

type TaskRunOptions = {
  /** 指定时仅从 OpenCode 当前已打开的项目中解析，并在该项目运行子代理。 */
  projectSelector?: string
  permission: string
  toolId: string
}

function makeTaskExecutor(input: {
  agent: Agent.Interface
  background: BackgroundJob.Interface
  config: Config.Interface
  sessions: Session.Interface
  scope: Scope.Scope
  database: Database.Interface
  store: InstanceStore.Interface
}) {
  const { agent, background, config, sessions, scope, database, store } = input

  const inProject = <A, E, R>(directory: string | undefined, effect: Effect.Effect<A, E, R>) =>
    directory ? store.provide({ directory }, effect) : effect

  const runOne = Effect.fn("TaskTool.runOne")(function* (input: {
    entry: ResolvedEntry
    ctx: Tool.Context
    parent: Session.Info
    cfg: ConfigShape
    variant: string | undefined
    inheritedContext: string | undefined
    wait: boolean
    batchId?: string
    projectDirectory?: string
    toolId: string
  }) {
    const { entry, ctx, parent, cfg, variant, wait, batchId, projectDirectory, toolId } = input

    const next = yield* inProject(projectDirectory, agent.get(entry.subagent_type))
    if (!next) {
      return yield* Effect.fail(new Error(`Unknown agent type: ${entry.subagent_type} is not a valid agent type`))
    }

    const existing = entry.task_id
      ? yield* sessions.get(SessionID.make(entry.task_id)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      : undefined

    if (existing && projectDirectory && !sameDirectory(existing.directory, projectDirectory)) {
      return yield* Effect.fail(
        new Error(
          `task_id ${entry.task_id} belongs to directory ${existing.directory}, not target ${projectDirectory}`,
        ),
      )
    }

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
      (yield* inProject(
        projectDirectory,
        sessions.create({
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
        }),
      ))

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
    if (projectDirectory) metadata.directory = projectDirectory
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

    // 提示词解析与模型执行必须共用目标项目上下文，避免只切换子会话目录。
    const runTask = Effect.fn("TaskTool.runTask")(function* () {
      return yield* inProject(
        projectDirectory,
        Effect.gen(function* () {
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
        }),
      )
    })

    // 完成通知仍回到来源项目，不能随子代理上下文写入目标项目会话。
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

    const cancelChild = inProject(projectDirectory, ops.cancel(nextSession.id))

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
      type: toolId,
      title: entry.description,
      metadata,
      onPromote: Effect.all([
        ctx.metadata({
          title: entry.description,
          metadata: { ...metadata, background: true, jobId: nextSession.id },
        }),
        notify(nextSession.id),
      ]),
      run: runTask().pipe(Effect.onInterrupt(() => cancelChild)),
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

    const runPromote = yield* EffectBridge.make()
    const promote = background.promote(nextSession.id)

    function onAbort() {
      runPromote.fork(promote)
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
          // 父会话停止等待时保留子代理，并转为后台任务继续回传结果。
          if (Exit.hasInterrupts(exit)) yield* promote
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              ctx.abort.removeEventListener("abort", onAbort)
            }),
          ),
        ),
    )
  })

  const run = Effect.fn("TaskTool.execute")(function* (
    params: TaskParams,
    ctx: Tool.Context,
    options: TaskRunOptions,
  ) {
    const projectDirectory = options.projectSelector
      ? resolveOpenedProject(options.projectSelector, yield* store.listLoaded()).directory
      : undefined

    // 深度和父会话属于来源项目，子代理配置则由目标项目决定。
    const cfg = (yield* inProject(projectDirectory, config.get())) as ConfigShape
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
      if (projectDirectory) {
        // 跨项目授权同时固定目标目录和子代理类型，避免宽泛授权被复用。
        for (const subagent_type of types) {
          yield* ctx.ask({
            permission: options.permission,
            patterns: [projectDirectory, subagent_type],
            always: [projectDirectory, "*"],
            metadata: {
              directory: projectDirectory,
              description: entries.map((entry) => entry.description).join(", "),
              subagent_type,
            },
          })
        }
      } else {
        for (const subagent_type of types) {
          yield* ctx.ask({
            permission: options.permission,
            patterns: [subagent_type],
            always: ["*"],
            metadata: {
              description: entries.map((entry) => entry.description).join(", "),
              subagent_type,
            },
          })
        }
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
            projectDirectory,
            toolId: options.toolId,
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
      if (projectDirectory) meta.directory = projectDirectory
      yield* ctx.metadata({
        title: `task: ${launched.length} sessions`,
        metadata: meta,
      })
      const lines = [
        `Started child sessions: ${launched.length}`,
        `batch_id: ${batchID}`,
        ...(projectDirectory ? [`directory: ${projectDirectory}`] : []),
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
        ...(projectDirectory ? { directory: projectDirectory } : {}),
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
      projectDirectory,
      toolId: options.toolId,
    })

    return {
      title: result.title,
      metadata: result.metadata as Record<string, unknown>,
      output: result.output,
    }
  })

  return { run }
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const executor = makeTaskExecutor({
      agent: yield* Agent.Service,
      background: yield* BackgroundJob.Service,
      config: yield* Config.Service,
      sessions: yield* Session.Service,
      scope: yield* Scope.Scope,
      database: yield* Database.Service,
      store: yield* InstanceStore.Service,
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: TaskParams, ctx: Tool.Context) =>
        executor
          .run(params, ctx, { permission: id, toolId: id })
          .pipe(Effect.orDie) as Effect.Effect<Tool.ExecuteResult>,
    }
  }),
)

export const ProjectTaskParameters = Schema.Struct({
  project: Schema.String.annotate({
    description:
      "An OpenCode project that is currently open. Accepts its directory path, directory name, or project name.",
  }),
  description: Parameters.fields.description,
  prompt: Parameters.fields.prompt,
  subagent_type: Parameters.fields.subagent_type,
  agent: Parameters.fields.agent,
  title: Parameters.fields.title,
  task_id: Parameters.fields.task_id,
  command: Parameters.fields.command,
  inherit_context: Parameters.fields.inherit_context,
  allow_nested_tasks: Parameters.fields.allow_nested_tasks,
  wait: Parameters.fields.wait,
  background: Parameters.fields.background,
  tasks: Parameters.fields.tasks,
})

type ProjectTaskParams = Schema.Schema.Type<typeof ProjectTaskParameters>

const PROJECT_TASK_ID = "project_task"

export const ProjectTaskTool = Tool.define(
  PROJECT_TASK_ID,
  Effect.gen(function* () {
    const executor = makeTaskExecutor({
      agent: yield* Agent.Service,
      background: yield* BackgroundJob.Service,
      config: yield* Config.Service,
      sessions: yield* Session.Service,
      scope: yield* Scope.Scope,
      database: yield* Database.Service,
      store: yield* InstanceStore.Service,
    })

    return {
      description: PROJECT_TASK_DESCRIPTION,
      parameters: ProjectTaskParameters,
      execute: (params: ProjectTaskParams, ctx: Tool.Context) => {
        const { project, ...taskParams } = params
        return executor
          .run(taskParams, ctx, {
            projectSelector: project,
            permission: PROJECT_TASK_ID,
            toolId: PROJECT_TASK_ID,
          })
          .pipe(Effect.orDie) as Effect.Effect<Tool.ExecuteResult>
      },
    }
  }),
)

export { createBatchID, getBatch, listBatches, registerBatch, registerTask, getTaskMeta } from "./task-registry"
