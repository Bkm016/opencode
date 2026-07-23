import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"

import { ProjectTaskTool, TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { InstanceState } from "../../src/effect/instance-state"
import { InstanceStore } from "../../src/project/instance-store"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { tmpdirScoped } from "../fixture/fixture"
import { TaskAsyncAbortTool, TaskAsyncStatusTool, TaskAsyncWaitTool } from "../../src/tool/task-async"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import path from "node:path"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)]],
  )

const it = testEffect(layer())

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function stubOps(opts?: { onPrompt?: (input: SessionPrompt.PromptInput) => void; text?: string }): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done")
      }),
  }
}

function reply(input: SessionPrompt.PromptInput, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

describe("tool.task", () => {
  it.instance(
    "description sorts subagents by name and is stable across calls",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const get = Effect.fnUntraced(function* () {
          const tools = yield* registry.tools({ ...ref, agent: build })
          return tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
        })
        const first = yield* get()
        const second = yield* get()

        expect(first).toBe(second)

        const alpha = first.indexOf("- alpha: Alpha agent")
        const explore = first.indexOf("- explore:")
        const general = first.indexOf("- general:")
        const zebra = first.indexOf("- zebra: Zebra agent")

        expect(alpha).toBeGreaterThan(-1)
        expect(explore).toBeGreaterThan(alpha)
        expect(general).toBeGreaterThan(explore)
        expect(zebra).toBeGreaterThan(general)
      }),
    {
      config: {
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance(
    "description hides denied subagents for the caller",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const description =
          (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

        expect(description).toContain("- alpha: Alpha agent")
        expect(description).not.toContain("- zebra: Zebra agent")
      }),
    {
      config: {
        permission: {
          task: {
            "*": "allow",
            zebra: "deny",
          },
        },
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance("execute resumes an existing task session from task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "resumed", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: child.id,
          wait: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(child.id)
      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.output).toContain(`<task id="${child.id}" state="completed">`)
      expect(seen?.sessionID).toBe(child.id)
      expect(seen?.variant).toBe("xhigh")
    }),
  )

  it.instance("execute asks by default and skips checks when bypassed", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: unknown[] = []
      const promptOps = stubOps()

      const exec = (extra?: Record<string, any>) =>
        def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            wait: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps, ...extra },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }),
          },
        )

      yield* exec()
      yield* exec({ bypassAgentCheck: true })

      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({
        permission: "task",
        patterns: ["general"],
        always: ["*"],
        metadata: {
          description: "inspect bug",
          subagent_type: "general",
        },
      })
    }),
  )

  it.instance("execute promotes the child session when abort signal fires", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = defer<SessionPrompt.PromptInput>()
      const abort = new AbortController()
      const cancelled: SessionID[] = []
      const promptOps: TaskPromptOps = {
        cancel: (sessionID) =>
          Effect.sync(() => {
            cancelled.push(sessionID)
          }),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.sync(() => {
            ready.resolve(input)
          }).pipe(Effect.andThen(Effect.never)),
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            wait: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: abort.signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      const input = yield* Effect.promise(() => ready.promise)
      abort.abort()
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(cancelled).toEqual([])
      const child = yield* jobs.get(input.sessionID)
      expect(child?.status).toBe("running")
      expect(child?.metadata?.background).toBe(true)
    }),
  )

  it.instance("execute creates a child when task_id does not exist", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "created", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: "ses_missing",
          wait: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(result.metadata.sessionId)
      expect(result.metadata.sessionId).not.toBe("ses_missing")
      expect(result.output).toContain(`<task id="${result.metadata.sessionId}" state="completed">`)
      expect(seen?.sessionID).toBe(result.metadata.sessionId)
    }),
  )

  it.instance("prevents subagents from launching subagents by default", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const nestedAssistant = yield* sessions.updateMessage({
        ...assistant,
        id: MessageID.ascending(),
        parentID: MessageID.ascending(),
        sessionID: child.id,
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let asked = false

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            wait: true,
          },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.sync(() => (asked = true)),
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(asked).toBe(false)
      expect(yield* sessions.children(child.id)).toHaveLength(0)
    }),
  )

  it.instance(
    "allows nested subagents up to the configured depth",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({ parentID: chat.id, title: "child" })
        const nestedAssistant = yield* sessions.updateMessage({
          ...assistant,
          id: MessageID.ascending(),
          parentID: MessageID.ascending(),
          sessionID: child.id,
        })
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            wait: true,
          },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect((yield* sessions.get(result.metadata.sessionId)).parentID).toBe(child.id)
      }),
    { config: { subagent_depth: 2 } },
  )

  it.instance(
    "execute shapes child permissions for task, todowrite, and primary tools",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "reviewer",
            wait: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const child = yield* sessions.get(result.metadata.sessionId)
        expect(child.parentID).toBe(chat.id)
        expect(child.agent).toBe("reviewer")
        expect(child.permission).toEqual(
          expect.arrayContaining([
            {
              permission: "todowrite",
              pattern: "*",
              action: "deny",
            },
            {
              permission: "bash",
              pattern: "*",
              action: "deny",
            },
            {
              permission: "read",
              pattern: "*",
              action: "deny",
            },
          ]),
        )
        // Nested orchestration denied by default; reviewer allowed only `task` so other async tools stay denied.
        expect(child.permission?.some((rule) => rule.permission === "task_async_status" && rule.action === "deny")).toBe(
          true,
        )
        expect(child.permission?.some((rule) => rule.permission === "task" && rule.action === "deny")).toBe(false)
        expect(seen?.tools).toBeUndefined()
      }),
    {
      config: {
        agent: {
          reviewer: {
            mode: "subagent",
            permission: {
              task: "allow",
            },
          },
        },
        experimental: {
          primary_tools: ["bash", "read"],
        },
      },
    },
  )

  it.instance("default execute returns running without waiting", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const job = yield* jobs.get(result.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.metadata.agent).toBe("general")
      expect(result.metadata.title).toBe("inspect bug")
      expect(result.output).toContain(`state="running"`)
      expect(job?.status).toBe("running")
    }),
  )

  it.instance("tasks batch returns per-child metadata for UI cards", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          tasks: [
            {
              description: "scan auth",
              prompt: "review auth module",
              subagent_type: "explore",
            },
            {
              description: "scan payments",
              prompt: "review payments module",
              subagent_type: "general",
            },
          ],
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.metadata.background).toBe(true)
      expect(result.metadata.count).toBe(2)
      expect(Array.isArray(result.metadata.taskIDs)).toBe(true)
      expect(result.metadata.taskIDs).toHaveLength(2)
      expect(typeof result.metadata.sessionId).toBe("string")
      expect(result.metadata.tasks).toEqual([
        {
          sessionId: result.metadata.taskIDs[0],
          title: "scan auth",
          agent: "explore",
        },
        {
          sessionId: result.metadata.taskIDs[1],
          title: "scan payments",
          agent: "general",
        },
      ])
      expect(result.output).toContain("batch_id:")
      expect(result.output).toContain("status: accepted (async)")
    }),
  )

  it.instance("recovers batch tasks from persisted tool metadata", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const first = yield* sessions.create({ parentID: chat.id, title: "scan auth" })
      const second = yield* sessions.create({ parentID: chat.id, title: "scan payments" })
      const batchID = `batch-${chat.id}`
      const waitBatchID = `wait-${chat.id}`
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: chat.id,
        type: "tool",
        callID: "task-batch-call",
        tool: "task",
        state: {
          status: "completed",
          input: {},
          output: "accepted",
          title: "task: 2 sessions",
          metadata: {
            batchID,
            taskIDs: [first.id, second.id],
          },
          time: { start: Date.now(), end: Date.now() },
        },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: chat.id,
        type: "tool",
        callID: "task-async-batch-call",
        tool: "task_async",
        state: {
          status: "completed",
          input: {},
          output: "accepted",
          title: "task: 2 sessions",
          metadata: {
            batchID: waitBatchID,
            taskIDs: [first.id, second.id],
          },
          time: { start: Date.now(), end: Date.now() },
        },
      })
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const statusTool = yield* TaskAsyncStatusTool
      const statusDef = yield* statusTool.init()
      const status = yield* statusDef.execute({ batch_id: batchID }, context)
      expect(status.metadata.count).toBe(2)
      expect(status.output).toContain(first.id)
      expect(status.output).toContain(second.id)

      const waitTool = yield* TaskAsyncWaitTool
      const waitDef = yield* waitTool.init()
      const waited = yield* waitDef.execute({ batch_id: waitBatchID }, context)
      expect(waited.metadata.task_ids).toEqual([first.id, second.id])
      expect(waited.metadata.completed).toBe(2)
    }),
  )

  it.instance("wait:true and background:false block until completion", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ctx = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps: stubOps({ text: "done" }) },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const waited = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          wait: true,
        },
        ctx,
      )
      expect(waited.output).toContain(`state="completed"`)
      expect(waited.metadata.background).toBeUndefined()

      const alias = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: false,
        },
        ctx,
      )
      expect(alias.output).toContain(`state="completed"`)
      expect(alias.metadata.background).toBeUndefined()
    }),
  )

  it.instance("promotes a running foreground task without restarting it", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()
      const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
      let runs = 0
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            return Deferred.succeed(injected, input).pipe(Effect.as(reply(input, "injected")))
          }
          return Effect.gen(function* () {
            runs += 1
            yield* Deferred.succeed(ready, undefined)
            yield* Deferred.await(done)
            return reply(input, "background done")
          })
        },
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            wait: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(ready)
      const job = (yield* jobs.list())[0]
      expect(job).toBeDefined()
      if (!job) throw new Error("task job not found")
      expect(job.metadata?.parentSessionId).toBe(chat.id)
      yield* jobs.promote(job.id)

      const result = yield* Fiber.join(fiber)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("running")
      expect(runs).toBe(1)

      yield* Deferred.succeed(done, undefined)
      expect((yield* jobs.wait({ id: result.metadata.sessionId })).info?.output).toBe("background done")
      expect((yield* Deferred.await(injected)).parts[0]?.type).toBe("text")
      expect(runs).toBe(1)
    }),
  )

  it.instance("background task completion waits for running updates", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const first = defer<void>()
      const second = defer<void>()
      const updated = defer<SessionPrompt.PromptInput>()
      const injected = defer<SessionPrompt.PromptInput>()
      let prompts = 0
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            injected.resolve(input)
            return Effect.succeed(reply(input, "done"))
          }
          prompts++
          if (prompts === 1) return Effect.promise(() => first.promise).pipe(Effect.as(reply(input, "first done")))
          updated.resolve(input)
          return Effect.promise(() => second.promise).pipe(Effect.as(reply(input, "second done")))
        },
      }
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const started = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        context,
      )
      const result = yield* def.execute(
        {
          description: "add investigation scope",
          prompt: "also inspect cancellation",
          subagent_type: "general",
          task_id: started.metadata.sessionId,
        },
        context,
      )

      expect(result.metadata.sessionId).toBe(started.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain("Background task updated")
      first.resolve()
      expect((yield* jobs.get(started.metadata.sessionId))?.status).toBe("running")
      const updatedParts = (yield* Effect.promise(() => updated.promise)).parts
      expect(updatedParts).toHaveLength(1)
      expect(updatedParts[0]?.type).toBe("text")
      if (updatedParts[0]?.type === "text") {
        expect(updatedParts[0].text).toContain("also inspect cancellation")
        expect(updatedParts[0].text).toContain("Nested delegation is disabled")
      }

      second.resolve()
      const waited = yield* jobs.wait({ id: started.metadata.sessionId, timeout: 1_000 })
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("second done")
      const notification = yield* Effect.promise(() => injected.promise)
      expect(notification.variant).toBe("xhigh")
      expect(notification.parts[0]?.type).toBe("text")
      if (notification.parts[0]?.type === "text") expect(notification.parts[0].text).toContain("second done")
    }),
  )

  it.instance("background tasks complete through the background job service", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ text: "background done" }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("background done")
    }),
  )

  it.instance("background task completion does not wait for the parent async prompt", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps({ text: "background done" }),
              prompt: (input) =>
                input.sessionID === chat.id ? Effect.never : Effect.succeed(reply(input, "background done")),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
    }),
  )

  it.instance("removing the parent session cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  it.instance("removing the child task session cancels its running background task", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(result.metadata.sessionId)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a waiting parent promotes the child job instead of stopping it", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const childStarted = yield* Deferred.make<SessionID>()
      const parentFiber = yield* runState
        .ensureRunning(
          chat.id,
          Effect.succeed(
            reply(
              {
                sessionID: chat.id,
                messageID: assistant.id,
                agent: "build",
                model: ref,
                parts: [],
              },
              "interrupted",
            ),
          ),
          def
            .execute(
              {
                description: "inspect bug",
                prompt: "look into the cache key path",
                subagent_type: "general",
                wait: true,
              },
              {
                sessionID: chat.id,
                messageID: assistant.id,
                agent: "build",
                abort: new AbortController().signal,
                extra: {
                  promptOps: {
                    ...stubOps(),
                    prompt: (input) =>
                      Deferred.succeed(childStarted, input.sessionID).pipe(Effect.andThen(Effect.never)),
                  } satisfies TaskPromptOps,
                },
                messages: [],
                metadata: () => Effect.void,
                ask: () => Effect.void,
              },
            )
            .pipe(
              Effect.as(
                reply(
                  {
                    sessionID: chat.id,
                    messageID: assistant.id,
                    agent: "build",
                    model: ref,
                    parts: [],
                  },
                  "completed",
                ),
              ),
            ),
        )
        .pipe(Effect.forkChild)
      const childID = yield* Deferred.await(childStarted)
      yield* pollWithTimeout(
        runState.assertNotBusy(chat.id).pipe(
          Effect.exit,
          Effect.map((exit) => (Exit.isFailure(exit) ? true : undefined)),
        ),
        "timed out waiting for the parent task wait to become busy",
      )
      yield* runState.cancel(chat.id)
      expect(Exit.isSuccess(yield* Fiber.await(parentFiber))).toBe(true)
      const child = yield* pollWithTimeout(
        jobs.get(childID).pipe(Effect.map((job) => (job?.metadata?.background === true ? job : undefined))),
        "timed out waiting for the interrupted task to become a background job",
      )
      expect(child.status).toBe("running")
      expect(Exit.isSuccess(yield* runState.assertNotBusy(chat.id).pipe(Effect.exit))).toBe(true)
    }),
  )

  it.instance("task_async_abort cancels both the BackgroundJob and child runner", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const abortTool = yield* TaskAsyncAbortTool
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const started = yield* Deferred.make<void>()
      const childFiber = yield* runState
        .ensureRunning(
          child.id,
          Effect.succeed(
            reply(
              {
                sessionID: child.id,
                messageID: MessageID.ascending(),
                agent: "build",
                model: ref,
                parts: [],
              },
              "interrupted",
            ),
          ),
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })

      const cancelled: SessionID[] = []
      const tool = yield* abortTool.init()
      const result = yield* tool.execute(
        { task_id: child.id },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              cancel: (sessionID: SessionID) =>
                Effect.gen(function* () {
                  cancelled.push(sessionID)
                  yield* runState.cancel(sessionID)
                }),
            },
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).toContain(`Aborted async task: ${child.id}`)
      expect(cancelled).toEqual([child.id])
      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
      expect(Exit.isSuccess(yield* Fiber.await(childFiber))).toBe(true)
      expect(Exit.isSuccess(yield* runState.assertNotBusy(child.id).pipe(Effect.exit))).toBe(true)
    }),
  )

  const waitCtx = (
    chat: { id: SessionID },
    assistant: { id: MessageID },
    opts?: { registered?: Deferred.Deferred<void>; callID?: string },
  ) => ({
    sessionID: chat.id,
    messageID: assistant.id,
    agent: "build",
    abort: new AbortController().signal,
    callID: opts?.callID,
    messages: [] as [],
    metadata: (input: { metadata?: Record<string, unknown> }) =>
      input.metadata?.registered === true && opts?.registered
        ? Deferred.succeed(opts.registered, undefined).pipe(Effect.ignore)
        : Effect.void,
    ask: () => Effect.void,
  })

  it.instance("task_async_wait releases once on onUserPrompt without cancelling the job", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const waitTool = yield* TaskAsyncWaitTool
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const done = yield* Deferred.make<void>()
      yield* jobs.start({
        id: child.id,
        type: "task",
        title: "child",
        metadata: { parentSessionId: chat.id, sessionId: child.id, background: true },
        run: Deferred.await(done).pipe(Effect.as("child done")),
      })

      const def = yield* waitTool.init()
      const registered = yield* Deferred.make<void>()
      const callID = "wait-call-1"
      const fiber = yield* def
        .execute(
          { task_id: child.id, timeout_seconds: 30 },
          waitCtx(chat, assistant, { registered, callID }),
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(registered)
      // 单次 onUserPrompt：生产路径不会重复 release。
      yield* runState.onUserPrompt(chat.id, [callID])
      const waited = yield* Fiber.join(fiber)
      expect(waited.metadata.released).toBe(true)
      expect(waited.metadata.pending).toBe(1)
      expect(waited.metadata.timed_out).toBe(false)
      expect(waited.output).toContain("released: true")
      expect(waited.output).toContain("still running")
      expect((yield* jobs.get(child.id))?.status).toBe("running")

      // 再次 wait 用新 callID，可正常等到完成（旧 sticky 不得误伤）。
      const registeredAgain = yield* Deferred.make<void>()
      const again = yield* def
        .execute(
          { task_id: child.id, timeout_seconds: 30 },
          waitCtx(chat, assistant, { registered: registeredAgain, callID: "wait-call-2" }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(registeredAgain)
      yield* Deferred.succeed(done, undefined)
      const finished = yield* Fiber.join(again)
      expect(finished.metadata.completed).toBe(1)
      expect(finished.metadata.released).toBe(false)
      expect(finished.metadata.pending).toBe(0)
    }),
  )

  it.instance("task_async_wait onUserPrompt is scoped to the parent session only", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const waitTool = yield* TaskAsyncWaitTool
      const { chat, assistant } = yield* seed("parent-a")
      const other = yield* sessions.create({ title: "parent-b" })
      const childA = yield* sessions.create({ parentID: chat.id, title: "child-a" })
      const childB = yield* sessions.create({ parentID: other.id, title: "child-b" })
      const doneA = yield* Deferred.make<void>()
      const doneB = yield* Deferred.make<void>()
      yield* jobs.start({
        id: childA.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: childA.id, background: true },
        run: Deferred.await(doneA).pipe(Effect.as("a")),
      })
      yield* jobs.start({
        id: childB.id,
        type: "task",
        metadata: { parentSessionId: other.id, sessionId: childB.id, background: true },
        run: Deferred.await(doneB).pipe(Effect.as("b")),
      })

      const def = yield* waitTool.init()
      const registeredA = yield* Deferred.make<void>()
      const registeredB = yield* Deferred.make<void>()
      const waitA = yield* def
        .execute(
          { task_id: childA.id, timeout_seconds: 30 },
          waitCtx(chat, assistant, { registered: registeredA, callID: "a-wait" }),
        )
        .pipe(Effect.forkChild)
      const waitB = yield* def
        .execute(
          { task_id: childB.id, timeout_seconds: 30 },
          {
            ...waitCtx(chat, assistant, { registered: registeredB, callID: "b-wait" }),
            sessionID: other.id,
          },
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(registeredA)
      yield* Deferred.await(registeredB)
      yield* runState.onUserPrompt(chat.id, ["a-wait"])
      const releasedA = yield* Fiber.join(waitA)
      expect(releasedA.metadata.released).toBe(true)
      const otherStillWaiting = yield* Fiber.join(waitB).pipe(
        Effect.timeoutOption("50 millis"),
        Effect.map((opt) => opt._tag === "None"),
      )
      expect(otherStillWaiting).toBe(true)

      yield* Deferred.succeed(doneB, undefined)
      const finishedB = yield* Fiber.join(waitB)
      expect(finishedB.metadata.completed).toBe(1)
      expect(finishedB.metadata.released).toBe(false)
      yield* Deferred.succeed(doneA, undefined)
    }),
  )

  it.instance("task_async_wait all/any release pending batch rows on onUserPrompt", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const waitTool = yield* TaskAsyncWaitTool
      const { chat, assistant } = yield* seed()
      const first = yield* sessions.create({ parentID: chat.id, title: "one" })
      const second = yield* sessions.create({ parentID: chat.id, title: "two" })
      const done = yield* Deferred.make<void>()
      for (const child of [first, second]) {
        yield* jobs.start({
          id: child.id,
          type: "task",
          metadata: { parentSessionId: chat.id, sessionId: child.id, background: true },
          run: Deferred.await(done).pipe(Effect.as("ok")),
        })
      }

      const def = yield* waitTool.init()

      const allRegistered = yield* Deferred.make<void>()
      const allFiber = yield* def
        .execute(
          { task_ids: [first.id, second.id], wait_for: "all", timeout_seconds: 30 },
          waitCtx(chat, assistant, { registered: allRegistered, callID: "all-wait" }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(allRegistered)
      yield* runState.onUserPrompt(chat.id, ["all-wait"])
      const all = yield* Fiber.join(allFiber)
      expect(all.metadata.released).toBe(true)
      expect(all.metadata.pending).toBe(2)
      expect(all.metadata.timed_out).toBe(false)
      expect(all.metadata.completed).toBe(0)

      const anyRegistered = yield* Deferred.make<void>()
      const anyFiber = yield* def
        .execute(
          { task_ids: [first.id, second.id], wait_for: "any", timeout_seconds: 30 },
          waitCtx(chat, assistant, { registered: anyRegistered, callID: "any-wait" }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(anyRegistered)
      yield* runState.onUserPrompt(chat.id, ["any-wait"])
      const any = yield* Fiber.join(anyFiber)
      expect(any.metadata.released).toBe(true)
      expect(any.metadata.pending).toBe(2)
      expect(any.metadata.completed).toBe(0)
      expect((yield* jobs.get(first.id))?.status).toBe("running")
      expect((yield* jobs.get(second.id))?.status).toBe("running")
      yield* Deferred.succeed(done, undefined)
    }),
  )

  it.instance("task_async_wait completion wins race without pending completed rows", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const waitTool = yield* TaskAsyncWaitTool
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id, background: true },
        run: Effect.succeed("done"),
      })
      yield* jobs.wait({ id: child.id })

      const def = yield* waitTool.init()
      const finished = yield* def.execute(
        { task_id: child.id, timeout_seconds: 5 },
        waitCtx(chat, assistant, { callID: "done-wait" }),
      )
      expect(finished.metadata.completed).toBe(1)
      expect(finished.metadata.pending).toBe(0)
      expect(finished.metadata.released).toBe(false)
      expect(finished.metadata.timed_out).toBe(false)
    }),
  )

  it.instance("task_async_wait cancel does not report new-message release", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const waitTool = yield* TaskAsyncWaitTool
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const done = yield* Deferred.make<void>()
      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id, background: true },
        run: Deferred.await(done).pipe(Effect.as("x")),
      })

      const def = yield* waitTool.init()
      const registered = yield* Deferred.make<void>()
      const fiber = yield* runState
        .ensureRunning(
          chat.id,
          Effect.succeed(
            reply(
              {
                sessionID: chat.id,
                messageID: assistant.id,
                agent: "build",
                model: ref,
                parts: [],
              },
              "interrupted",
            ),
          ),
          def
            .execute(
              { task_id: child.id, timeout_seconds: 30 },
              waitCtx(chat, assistant, { registered, callID: "cancel-wait" }),
            )
            .pipe(
              Effect.as(
                reply(
                  {
                    sessionID: chat.id,
                    messageID: assistant.id,
                    agent: "build",
                    model: ref,
                    parts: [],
                  },
                  "completed",
                ),
              ),
            ),
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(registered)
      yield* runState.cancel(chat.id)
      expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true)
      // cancel 不发布 new-message release；子 job 仍 running。
      expect((yield* jobs.get(child.id))?.status).toBe("running")
      yield* Deferred.succeed(done, undefined)
    }),
  )

  it.instance("task_async_wait sticky only matches the running callID", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const waitTool = yield* TaskAsyncWaitTool
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const done = yield* Deferred.make<void>()
      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id, background: true },
        run: Deferred.await(done).pipe(Effect.as("x")),
      })

      // 仅 sticky 指定 callID；不同 callID 的 wait 不得被旧 release 误伤。
      yield* runState.onUserPrompt(chat.id, ["sticky-call"])
      const def = yield* waitTool.init()
      const sticky = yield* def.execute(
        { task_id: child.id, timeout_seconds: 30 },
        waitCtx(chat, assistant, { callID: "sticky-call" }),
      )
      expect(sticky.metadata.released).toBe(true)
      expect(sticky.metadata.pending).toBe(1)

      const registered = yield* Deferred.make<void>()
      const next = yield* def
        .execute(
          { task_id: child.id, timeout_seconds: 30 },
          waitCtx(chat, assistant, { registered, callID: "fresh-call" }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(registered)
      const stillWaiting = yield* Fiber.join(next).pipe(
        Effect.timeoutOption("50 millis"),
        Effect.map((opt) => opt._tag === "None"),
      )
      expect(stillWaiting).toBe(true)
      yield* Deferred.succeed(done, undefined)
      const finished = yield* Fiber.join(next)
      expect(finished.metadata.completed).toBe(1)
      expect(finished.metadata.released).toBe(false)
    }),
  )

  it.instance("task_async_wait busy runner without running wait callIDs does not sticky", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const waitTool = yield* TaskAsyncWaitTool
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const done = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id, background: true },
        run: Deferred.await(done).pipe(Effect.as("x")),
      })

      // 普通 busy 流（无 running wait callID）后的新 wait 必须正常阻塞。
      const parentFiber = yield* runState
        .ensureRunning(
          chat.id,
          Effect.succeed(
            reply(
              {
                sessionID: chat.id,
                messageID: assistant.id,
                agent: "build",
                model: ref,
                parts: [],
              },
              "interrupted",
            ),
          ),
          Deferred.succeed(gate, undefined).pipe(Effect.andThen(Effect.never)),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(gate)
      yield* runState.onUserPrompt(chat.id, [])

      const def = yield* waitTool.init()
      const registered = yield* Deferred.make<void>()
      const fiber = yield* def
        .execute(
          { task_id: child.id, timeout_seconds: 30 },
          waitCtx(chat, assistant, { registered, callID: "later-wait" }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(registered)
      const stillWaiting = yield* Fiber.join(fiber).pipe(
        Effect.timeoutOption("50 millis"),
        Effect.map((opt) => opt._tag === "None"),
      )
      expect(stillWaiting).toBe(true)
      yield* Deferred.succeed(done, undefined)
      const finished = yield* Fiber.join(fiber)
      expect(finished.metadata.completed).toBe(1)
      expect(finished.metadata.released).toBe(false)

      yield* runState.cancel(chat.id)
      yield* Fiber.await(parentFiber)
    }),
  )
})

describe("tool.project_task", () => {
  it.instance("execute creates a child session in the target project directory", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const target = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: target })
      const tool = yield* ProjectTaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      let promptDirectory: string | undefined
      const promptOps = stubOps({
        text: "cross-project",
        onPrompt: (input) => {
          seen = input
        },
      })
      const wrapped: TaskPromptOps = {
        ...promptOps,
        prompt: (input) =>
          Effect.gen(function* () {
            promptDirectory = yield* InstanceState.directory
            return yield* promptOps.prompt(input)
          }),
      }

      const asks: unknown[] = []
      const result = yield* def.execute(
        {
          project: path.basename(target),
          description: "cross project",
          prompt: "inspect the other repo",
          subagent_type: "general",
          wait: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: wrapped, openProjectDirectories: [target] },
          messages: [],
          metadata: () => Effect.void,
          ask: (input) =>
            Effect.sync(() => {
              asks.push(input)
            }),
        },
      )

      const child = yield* sessions.get(result.metadata.sessionId as SessionID)
      expect(child.directory).toBe(FSUtil.resolve(target))
      expect(child.parentID).toBe(chat.id)
      expect(result.metadata.directory).toBe(FSUtil.resolve(target))
      expect(seen?.sessionID).toBe(child.id)
      expect(seen?.openProjectDirectories).toEqual([target])
      expect(promptDirectory).toBe(FSUtil.resolve(target))
      expect(asks).toEqual([
        {
          permission: "project_task",
          patterns: [FSUtil.resolve(target), "general"],
          always: [FSUtil.resolve(target), "*"],
          metadata: {
            directory: FSUtil.resolve(target),
            description: "cross project",
            subagent_type: "general",
          },
        },
      ])
      expect(result.output).toContain(`<task id="${child.id}" state="completed">`)
    }),
  )

  it.instance("rejects a project that is not currently open", () =>
    Effect.gen(function* () {
      const store = yield* InstanceStore.Service
      const { chat, assistant } = yield* seed()
      const target = yield* tmpdirScoped({ git: true })
      const tool = yield* ProjectTaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            project: target,
            description: "closed project",
            prompt: "should fail",
            subagent_type: "general",
            wait: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("currently open in OpenCode")
      expect((yield* store.listLoaded()).some((ctx) => ctx.directory === FSUtil.resolve(target))).toBe(false)
    }),
  )

  it.instance("rejects a loaded project without Desktop open-project authorization", () =>
    Effect.gen(function* () {
      const store = yield* InstanceStore.Service
      const { chat, assistant } = yield* seed()
      const target = yield* tmpdirScoped({ git: true })
      yield* store.load({ directory: target })
      const tool = yield* ProjectTaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            project: target,
            description: "not open in desktop",
            prompt: "should fail",
            subagent_type: "general",
            wait: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("currently open in OpenCode")
    }),
  )

  it.instance("accepts a project that is in Desktop openProjectDirectories", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const target = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: target })
      const tool = yield* ProjectTaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          project: path.basename(target),
          description: "open in desktop",
          prompt: "should work",
          subagent_type: "general",
          wait: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ text: "ok" }), openProjectDirectories: [target] },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const child = yield* sessions.get(result.metadata.sessionId as SessionID)
      expect(child.directory).toBe(FSUtil.resolve(target))
    }),
  )

  it.instance("rejects an ambiguous open project name", () =>
    Effect.gen(function* () {
      const store = yield* InstanceStore.Service
      const origin = yield* InstanceState.context
      const { chat, assistant } = yield* seed()
      const left = yield* tmpdirScoped()
      const right = yield* tmpdirScoped()
      yield* store.load({
        directory: left,
        worktree: left,
        project: { ...origin.project, name: "shared", worktree: left },
      })
      yield* store.load({
        directory: right,
        worktree: right,
        project: { ...origin.project, name: "shared", worktree: right },
      })
      const tool = yield* ProjectTaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            project: "shared",
            description: "ambiguous project",
            prompt: "should fail",
            subagent_type: "general",
            wait: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps(), openProjectDirectories: [left, right] },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("selector is ambiguous")
        expect(String(exit.cause)).toContain(left)
        expect(String(exit.cause)).toContain(right)
      }
    }),
  )

  it.instance("rejects task_id resume when existing session directory does not match target", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const other = yield* sessions.create({ parentID: chat.id, title: "same-project child" })
      const target = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: target })
      const tool = yield* ProjectTaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            project: target,
            description: "resume mismatch",
            prompt: "should fail",
            subagent_type: "general",
            task_id: other.id,
            wait: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps(), openProjectDirectories: [target] },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const message = String(exit.cause)
        expect(message).toContain("belongs to directory")
        expect(message).toContain(other.directory)
      }
    }),
  )

  it.instance("resumes task_id when existing session directory matches target", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const target = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const child = yield* store.provide(
        { directory: target },
        sessions.create({ parentID: chat.id, title: "target child" }),
      )
      const tool = yield* ProjectTaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined

      const result = yield* def.execute(
        {
          project: target,
          description: "resume match",
          prompt: "continue",
          subagent_type: "general",
          task_id: child.id,
          wait: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: stubOps({ text: "resumed", onPrompt: (input) => (seen = input) }),
            openProjectDirectories: [target],
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.metadata.sessionId).toBe(child.id)
      expect(seen?.sessionID).toBe(child.id)
      expect(yield* sessions.children(chat.id)).toHaveLength(1)
    }),
  )

  it.instance("is registered alongside task", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const build = yield* agent.get("build")
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({ ...ref, agent: build })
      expect(tools.some((tool) => tool.id === "project_task")).toBe(true)
      expect(tools.some((tool) => tool.id === "task")).toBe(true)
    }),
  )
})
