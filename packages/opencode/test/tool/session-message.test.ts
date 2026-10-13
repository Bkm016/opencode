import { afterEach, describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect } from "effect"
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
import {
  MAX_HOPS,
  SessionListTool,
  SessionMessageTool,
  currentHops,
  normalizeHandle,
  renderPeerMessage,
} from "../../src/tool/session-message"
import type { TaskPromptOps } from "../../src/tool/task"
import type { Tool } from "../../src/tool/tool"
import { Truncate } from "@/tool/truncate"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const it = testEffect(
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
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer({})]],
  ),
)

const addUser = Effect.fn("SessionMessageTest.addUser")(function* (
  sessionID: SessionID,
  input: { agent: string; model?: typeof ref & { variant?: string }; text?: string; hops?: number },
) {
  const sessions = yield* Session.Service
  const info: SessionV1.User = {
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: input.agent,
    model: input.model ?? ref,
    time: { created: Date.now() },
  }
  yield* sessions.updateMessage(info)
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: info.id,
    sessionID,
    type: "text",
    text: input.text ?? "hi",
    ...(input.hops === undefined ? {} : { synthetic: true, metadata: { peerMessage: { hops: input.hops } } }),
  })
  return (yield* sessions.messages({ sessionID })).filter((message) => message.info.id === info.id)
})

function ops(seen: SessionPrompt.PromptInput[]): TaskPromptOps {
  const unused = () => Effect.die(new Error("unused"))
  return {
    cancel: () => Effect.void,
    resolvePromptParts: unused,
    admit: unused,
    resume: unused,
    prompt: (input) => {
      seen.push(input)
      return Effect.die(new Error("stub prompt"))
    },
  }
}

function context(input: {
  sessionID: SessionID
  promptOps: TaskPromptOps
  messages?: SessionV1.WithParts[]
  asks?: { permission: string; patterns: string[] }[]
}) {
  return {
    sessionID: input.sessionID,
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    extra: { promptOps: input.promptOps },
    metadata: () => Effect.void,
    ask: (request: Parameters<Tool.Context["ask"]>[0]) =>
      Effect.sync(() => void input.asks?.push({ permission: request.permission, patterns: [...request.patterns] })),
    messages: input.messages ?? [],
  }
}

describe("session_message helpers", () => {
  test("normalizes @names", () => {
    expect(normalizeHandle("@brave-wolf")).toBe("brave-wolf")
    expect(normalizeHandle("  @@brave-wolf ")).toBe("brave-wolf")
    expect(normalizeHandle("ses_123")).toBe("ses_123")
  })

  test("renders a framed peer message", () => {
    const text = renderPeerMessage({ slug: "brave-wolf", sessionID: "ses_1", hops: 2, message: "v95 is not mine" })
    expect(text).toContain('<peer-message from="@brave-wolf" session="ses_1" hops="2">')
    expect(text).toContain("v95 is not mine")
    expect(text).toContain("not from the user")
  })
})

describe("session_list", () => {
  it.instance("lists other primary sessions with their state", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const self = yield* sessions.create({ title: "Me" })
      const peer = yield* sessions.create({ title: "Peer one", agent: "build" })
      const child = yield* sessions.create({ title: "Subagent", parentID: peer.id })
      yield* status.set(peer.id, { type: "busy" })

      const tool = yield* SessionListTool
      const def = yield* tool.init()
      const result = yield* def.execute({}, context({ sessionID: self.id, promptOps: ops([]) }))

      expect(result.output).toContain(`@${peer.slug}`)
      expect(result.output).toContain("[busy]")
      expect(result.output).toContain(`id=${peer.id}`)
      expect(result.output).not.toContain(self.id)
      expect(result.output).not.toContain(child.id)
    }),
  )

  it.instance("says so when nobody else exists", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const self = yield* sessions.create({ title: "Alone" })
      const tool = yield* SessionListTool
      const def = yield* tool.init()
      const result = yield* def.execute({}, context({ sessionID: self.id, promptOps: ops([]) }))
      expect(result.output).toBe("No other sessions in this project.")
    }),
  )
})

describe("session_message", () => {
  it.instance("delivers a synthetic peer message using the target's own agent and model", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const self = yield* sessions.create({ title: "Sender" })
      const target = yield* sessions.create({ title: "Receiver" })
      const targetModel = { ...ref, modelID: ModelV2.ID.make("other-model"), variant: "high" }
      yield* addUser(target.id, { agent: "plan", model: targetModel })
      yield* status.set(target.id, { type: "busy" })

      const seen: SessionPrompt.PromptInput[] = []
      const asks: { permission: string; patterns: string[] }[] = []
      const tool = yield* SessionMessageTool
      const def = yield* tool.init()
      const result = yield* def.execute(
        { to: `@${target.slug}`, message: "Did you change v95?" },
        context({ sessionID: self.id, promptOps: ops(seen), asks }),
      )
      yield* Effect.yieldNow

      expect(result.metadata).toMatchObject({ delivered: true, busy: true, hops: 1, slug: target.slug })
      expect(result.output).toContain("busy")
      expect(asks).toEqual([{ permission: "session_message", patterns: [target.slug] }])
      expect(seen).toHaveLength(1)
      const input = seen[0]
      expect(input.sessionID).toBe(target.id)
      expect(input.agent).toBe("plan")
      expect(String(input.model?.modelID)).toBe("other-model")
      expect(input.variant).toBe("high")
      const part = input.parts[0]
      expect(part.type).toBe("text")
      if (part.type !== "text") return
      expect(part.synthetic).toBe(true)
      expect(part.text).toContain(`<peer-message from="@${self.slug}"`)
      expect(part.text).toContain("Did you change v95?")
      expect(part.metadata?.peerMessage).toMatchObject({ from: self.id, slug: self.slug, hops: 1 })
    }),
  )

  it.instance("accepts the full session ID and reports an idle target as woken", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const self = yield* sessions.create({ title: "Sender" })
      const target = yield* sessions.create({ title: "Receiver", agent: "build" })

      const seen: SessionPrompt.PromptInput[] = []
      const tool = yield* SessionMessageTool
      const def = yield* tool.init()
      const result = yield* def.execute(
        { to: target.id, message: "ping" },
        context({ sessionID: self.id, promptOps: ops(seen) }),
      )
      yield* Effect.yieldNow

      expect(result.metadata).toMatchObject({ delivered: true, busy: false })
      expect(result.output).toContain("idle")
      expect(seen[0].agent).toBe("build")
      expect(seen[0].model).toBeUndefined()
    }),
  )

  it.instance("refuses unknown, own, child and empty targets without prompting", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const self = yield* sessions.create({ title: "Sender" })
      const peer = yield* sessions.create({ title: "Peer" })
      const child = yield* sessions.create({ title: "Child", parentID: peer.id })

      const seen: SessionPrompt.PromptInput[] = []
      const tool = yield* SessionMessageTool
      const def = yield* tool.init()
      const run = (to: string, message = "hello") =>
        def.execute({ to, message }, context({ sessionID: self.id, promptOps: ops(seen) }))

      expect((yield* run("@no-such-session")).output).toContain("session_list")
      expect((yield* run(self.id)).output).toContain("own session")
      expect((yield* run(child.id)).output).toContain("No session matches")
      const empty = yield* run(peer.id, "   ")
      expect(empty.output).toBe("Message is empty.")
      expect(empty.metadata.delivered).toBe(false)
      yield* Effect.yieldNow
      expect(seen).toHaveLength(0)
    }),
  )

  it.instance("counts hops from the message that started this turn and cuts long chains", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const self = yield* sessions.create({ title: "Sender" })
      const target = yield* sessions.create({ title: "Receiver" })
      const seen: SessionPrompt.PromptInput[] = []
      const tool = yield* SessionMessageTool
      const def = yield* tool.init()

      const third = yield* addUser(self.id, { agent: "build", text: "peer", hops: 3 })
      const reply = yield* def.execute(
        { to: target.id, message: "answer" },
        context({ sessionID: self.id, promptOps: ops(seen), messages: third }),
      )
      yield* Effect.yieldNow
      expect(reply.metadata).toMatchObject({ delivered: true, hops: 4 })

      const last = yield* addUser(self.id, { agent: "build", text: "peer", hops: MAX_HOPS })
      const cut = yield* def.execute(
        { to: target.id, message: "again" },
        context({ sessionID: self.id, promptOps: ops(seen), messages: last }),
      )
      yield* Effect.yieldNow
      expect(cut.metadata.delivered).toBe(false)
      expect(cut.output).toContain("report the outcome to the user")
      expect(seen).toHaveLength(1)

      // 用户新发的消息重置链条
      const fresh = yield* addUser(self.id, { agent: "build", text: "user typed this" })
      expect(currentHops([...last, ...fresh])).toBe(0)
    }),
  )
})
