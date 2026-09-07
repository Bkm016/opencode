import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { SessionChunk } from "@/session/chunk"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { HistoryGrepTool, HistoryListTool } from "@/tool/history"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"

const sessionID = SessionID.make("ses_history_test")
const messageID = MessageID.ascending()
const partID = PartID.ascending()
const message: SessionV1.WithParts = {
  info: {
    id: messageID,
    role: "user",
    sessionID,
    agent: "build",
    model: { providerID: "test" as any, modelID: "test-model" as any },
    time: { created: 0 },
  },
  parts: [
    {
      id: partID,
      messageID,
      sessionID,
      type: "text",
      text: "first line\nneedle in the original log\nlast line",
    },
  ],
}

const layer = Layer.mergeAll(
  Layer.mock(Session.Service, { messages: () => Effect.succeed([message]) }),
  Layer.mock(Agent.Service, { get: () => Effect.succeed({ name: "build", permission: [] } as any) }),
  Layer.mock(Truncate.Service, {
    output: (content: string) => Effect.succeed({ content, truncated: false as const }),
  }),
)
const it = testEffect(layer)

const context: Tool.Context = {
  sessionID,
  messageID,
  agent: "build",
  abort: new AbortController().signal,
  messages: [message],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

function assistant(parentID: MessageID, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      parentID,
      role: "assistant",
      sessionID,
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test-model" as SessionV1.Assistant["modelID"],
      providerID: "test" as SessionV1.Assistant["providerID"],
      time: { created: 0 },
      finish: "stop",
    },
    parts: [{ id: PartID.ascending(), messageID: id, sessionID, type: "text", text }],
  }
}

describe("history tools", () => {
  test("lists an unchunked user text by message and part reference", async () => {
    const tool = await Effect.runPromise(HistoryListTool.pipe(Effect.flatMap(Tool.init), Effect.provide(layer)))
    const result = await Effect.runPromise(
      tool.execute({ message_id: String(messageID), part_id: String(partID), offset: 1, limit: 1 }, context).pipe(Effect.provide(layer)),
    )

    expect(result.output).toContain("needle in the original log")
    expect(result.output).toContain(`message=${messageID}`)
    expect(result.metadata.total).toBe(3)
  })

  test("searches an unchunked user text by message and part reference", async () => {
    const tool = await Effect.runPromise(HistoryGrepTool.pipe(Effect.flatMap(Tool.init), Effect.provide(layer)))
    const result = await Effect.runPromise(
      tool.execute({ pattern: "original log", message_id: String(messageID), part_id: String(partID) }, context).pipe(Effect.provide(layer)),
    )

    expect(result.output).toContain("needle in the original log")
    expect(result.metadata.matches).toBe(1)
  })

  it.effect("reads a later chunk using the exact coordinates returned by grep", () => {
    const first = assistant(messageID, "previous chunk result")
    const nextID = MessageID.ascending()
    const next: SessionV1.WithParts = {
      info: { ...message.info, id: nextID },
      parts: [{ id: PartID.ascending(), messageID: nextID, sessionID, type: "text", text: "later chunk needle" }],
    }
    const messages = [message, first, next, assistant(nextID, "next result")]
    const firstChunk = SessionChunk.closeChunk({ messages, chunks: [] })!
    const chunks = [firstChunk, SessionChunk.closeChunk({ messages, chunks: [firstChunk] })!]
    const holderID = MessageID.ascending()
    messages.push({
      info: { ...message.info, id: holderID },
      parts: [{ id: PartID.ascending(), messageID: holderID, sessionID, type: "compaction", auto: false, chunks }],
    })

    return Effect.gen(function* () {
      const grep = yield* HistoryGrepTool.pipe(Effect.flatMap(Tool.init))
      const list = yield* HistoryListTool.pipe(Effect.flatMap(Tool.init))
      const found = yield* grep.execute({ pattern: "later chunk needle" }, context)
      const coordinate = /chunk (\S+) \(sequence \d+\) USER line (\d+):/.exec(found.output)
      expect(coordinate).not.toBeNull()
      if (!coordinate) throw new Error("Missing chunk coordinates")
      expect(found.output).not.toContain("previous chunk result")
      const read = yield* list.execute({ chunk_id: coordinate[1], offset: Number(coordinate[2]), limit: 1 }, context)
      expect(read.output).toContain("later chunk needle")
      expect(read.metadata.lines).toBe(1)
      const scoped = yield* grep.execute({ pattern: "later chunk needle", chunk_id: coordinate[1] }, context)
      expect(scoped.output).toBe(found.output)
    }).pipe(Effect.provide(Layer.mock(Session.Service, { messages: () => Effect.succeed(messages) })))
  })

  it.effect("reads a later text part without changing paths or escape sequences", () => {
    const text = String.raw`C:\project\cache.json {"line":"first\nsecond"}`
    const secondPart = PartID.ascending()
    const multipart: SessionV1.WithParts = {
      ...message,
      parts: [...message.parts, { id: secondPart, messageID, sessionID, type: "text", text }],
    }
    return Effect.gen(function* () {
      const grep = yield* HistoryGrepTool.pipe(Effect.flatMap(Tool.init))
      const list = yield* HistoryListTool.pipe(Effect.flatMap(Tool.init))
      const found = yield* grep.execute({ pattern: String.raw`first\nsecond`, message_id: String(messageID) }, context)
      const coordinate = /message (\S+) part (\S+) USER line (\d+):/.exec(found.output)
      expect(coordinate).not.toBeNull()
      if (!coordinate) throw new Error("Missing user text coordinates")
      expect(found.output).not.toContain("needle in the original log")
      const read = yield* list.execute({
        message_id: coordinate[1],
        part_id: coordinate[2],
        offset: Number(coordinate[3]),
        limit: 1,
      }, context)
      expect(read.output).toContain(text)
      expect(read.metadata.lines).toBe(1)
    }).pipe(Effect.provide(Layer.mock(Session.Service, { messages: () => Effect.succeed([multipart]) })))
  })
})
