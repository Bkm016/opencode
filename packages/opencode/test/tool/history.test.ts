import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { HistoryGrepTool, HistoryListTool } from "@/tool/history"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"

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

const context: Tool.Context = {
  sessionID,
  messageID,
  agent: "build",
  abort: new AbortController().signal,
  messages: [message],
  metadata: () => Effect.void,
  ask: () => Effect.void,
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
})
