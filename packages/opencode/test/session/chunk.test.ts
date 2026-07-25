import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionChunk } from "../../src/session/chunk"

const sessionID = SessionID.make("ses_test")
const ref = { providerID: "test" as any, modelID: "test-model" as any }

let seq = 0
function mid() {
  return MessageID.ascending()
}

function user(text: string, synthetic = false): SessionV1.WithParts {
  const id = mid()
  return {
    info: {
      id,
      role: "user",
      sessionID,
      agent: "build",
      model: ref,
      time: { created: Date.now() + seq++ },
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID,
        type: "text",
        text,
        synthetic: synthetic || undefined,
      },
    ],
  }
}

function assistant(
  parentID: MessageID,
  text: string,
  opts: {
    finish?: SessionV1.Assistant["finish"]
    error?: SessionV1.Assistant["error"]
    tool?: boolean
  } = {},
): SessionV1.WithParts {
  const id = mid()
  const parts: SessionV1.Part[] = []
  if (opts.tool) {
    parts.push({
      id: PartID.ascending(),
      messageID: id,
      sessionID,
      type: "tool",
      callID: "call_1",
      tool: "read",
      state: {
        status: "completed",
        input: { path: "/a.ts" },
        output: "file contents",
        title: "read",
        metadata: {},
        time: { start: 0, end: 1 },
      },
    } as SessionV1.ToolPart)
  }
  parts.push({
    id: PartID.ascending(),
    messageID: id,
    sessionID,
    type: "text",
    text,
  })
  return {
    info: {
      id,
      role: "assistant",
      sessionID,
      parentID,
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { output: 1, input: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: Date.now() + seq++ },
      finish: opts.finish,
      error: opts.error,
    } as SessionV1.Assistant,
    parts,
  }
}

describe("closeChunk", () => {
  test("closes region ending with finish=stop", () => {
    const u1 = user("hello")
    const a1 = assistant(u1.info.id, "world", { finish: "stop" })
    const chunk = SessionChunk.closeChunk({ messages: [u1, a1], chunks: [] })
    expect(chunk).toBeDefined()
    expect(chunk!.status).toBe("completed")
    expect(chunk!.start_message_id).toBe(u1.info.id)
    expect(chunk!.end_message_id).toBe(a1.info.id)
    expect(chunk!.sequence).toBe(1)
    expect(chunk!.display_id).toHaveLength(8)
  })

  test("does not close when finish=tool-calls", () => {
    const u1 = user("hello")
    const a1 = assistant(u1.info.id, "", { finish: "tool-calls", tool: true })
    const chunk = SessionChunk.closeChunk({ messages: [u1, a1], chunks: [] })
    expect(chunk).toBeUndefined()
  })

  test("does not close with open tool calls", () => {
    const u1 = user("hello")
    const id = mid()
    const pending: SessionV1.WithParts = {
      info: {
        id,
        role: "assistant",
        sessionID,
        parentID: u1.info.id,
        mode: "build",
        agent: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { output: 1, input: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: Date.now() + seq++ },
        finish: "stop",
      } as SessionV1.Assistant,
      parts: [
        {
          id: PartID.ascending(),
          messageID: id,
          sessionID,
          type: "tool",
          callID: "call_x",
          tool: "shell",
          state: { status: "running", input: {}, title: "", metadata: {}, time: { start: 0 } },
        } as SessionV1.ToolPart,
      ],
    }
    expect(SessionChunk.closeChunk({ messages: [u1, pending], chunks: [] })).toBeUndefined()
  })

  test("maps error finish and error object to failed", () => {
    const u1 = user("hello")
    const a1 = assistant(u1.info.id, "partial", { finish: "error" })
    expect(SessionChunk.closeChunk({ messages: [u1, a1], chunks: [] })!.status).toBe("failed")

    const a2 = assistant(u1.info.id, "blocked", { finish: "content-filter" })
    expect(SessionChunk.closeChunk({ messages: [u1, a2], chunks: [] })!.status).toBe("failed")

    const a3 = assistant(u1.info.id, "long", { finish: "length" })
    expect(SessionChunk.closeChunk({ messages: [u1, a3], chunks: [] })!.status).toBe("failed")
  })

  test("maps abort to interrupted", () => {
    const u1 = user("hello")
    const a1 = assistant(u1.info.id, "partial", {
      finish: "stop",
      error: new SessionV1.AbortedError({ message: "aborted" }).toObject(),
    })
    expect(SessionChunk.closeChunk({ messages: [u1, a1], chunks: [] })!.status).toBe("interrupted")
  })

  test("17 user / 7 stop structure closes 7 chunks sequentially", () => {
    const messages: SessionV1.WithParts[] = []
    const chunks: SessionChunk.Chunk[] = []
    for (let round = 0; round < 7; round++) {
      const start = messages.length
      // 前两轮各 3 个 user steering，后续每轮 2 个，共 17 个 user
      const steering = round < 2 ? 3 : 2
      let parent: MessageID | undefined
      for (let s = 0; s < steering + 1; s++) {
        const u = user(`round ${round} msg ${s}`)
        messages.push(u)
        parent = u.info.id
      }
      const a = assistant(parent!, `final ${round}`, { finish: "stop" })
      messages.push(a)
      const next = SessionChunk.closeChunk({ messages, chunks })
      expect(next).toBeDefined()
      expect(next!.start_message_id).toBe(messages[start]!.info.id)
      expect(next!.end_message_id).toBe(a.info.id)
      chunks.push(next!)
    }
    expect(chunks).toHaveLength(7)
    expect(chunks.map((c) => c.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7])
    // display id 唯一
    expect(new Set(chunks.map((c) => c.display_id)).size).toBe(7)
  })

  test("does not close region when last message is user", () => {
    const u1 = user("hello")
    const a1 = assistant(u1.info.id, "world", { finish: "stop" })
    const first = SessionChunk.closeChunk({ messages: [u1, a1], chunks: [] })!
    const u2 = user("more work")
    expect(SessionChunk.closeChunk({ messages: [u1, a1, u2], chunks: [first] })).toBeUndefined()
  })
})

describe("selectVisible", () => {
  function build(count: number, userText: string, finalText: string) {
    const messages: SessionV1.WithParts[] = []
    const chunks: SessionChunk.Chunk[] = []
    for (let i = 0; i < count; i++) {
      const u = user(userText)
      const a = assistant(u.info.id, finalText, { finish: "stop" })
      messages.push(u, a)
      chunks.push(SessionChunk.closeChunk({ messages, chunks })!)
    }
    return { messages, chunks }
  }

  test("selects latest contiguous suffix within target budget", () => {
    const { messages, chunks } = build(5, "短问题", "短回答")
    const selection = SessionChunk.selectVisible({
      messages,
      chunks,
      targetTokens: 100,
      hardTokens: 200,
    })
    expect(selection.visible.length).toBeGreaterThan(0)
    expect(selection.visible.length).toBeLessThan(5)
    // 连续后缀
    const seqs = selection.visible.map((c) => c.sequence)
    expect(seqs).toEqual(seqs.map((_, i) => seqs[0]! + i))
    expect(seqs.at(-1)).toBe(5)
  })

  test("user text over hard budget marks oversize", () => {
    const bigUser = "汉".repeat(30_000)
    const { messages, chunks } = build(1, bigUser, "ok")
    const selection = SessionChunk.selectVisible({
      messages,
      chunks,
      targetTokens: 20_000,
      hardTokens: 24_000,
    })
    expect(selection.oversize).toBeDefined()
    expect(selection.visible).toHaveLength(0)
  })

  test("oversize final response excludes whole chunk and stops suffix", () => {
    const messages: SessionV1.WithParts[] = []
    const chunks: SessionChunk.Chunk[] = []
    const u1 = user("small")
    const a1 = assistant(u1.info.id, "small answer", { finish: "stop" })
    messages.push(u1, a1)
    chunks.push(SessionChunk.closeChunk({ messages, chunks })!)
    const u2 = user("small 2")
    const a2 = assistant(u2.info.id, "汉".repeat(30_000), { finish: "stop" })
    messages.push(u2, a2)
    chunks.push(SessionChunk.closeChunk({ messages, chunks })!)

    const selection = SessionChunk.selectVisible({
      messages,
      chunks,
      targetTokens: 20_000,
      hardTokens: 24_000,
    })
    // 最新 chunk 整 chunk 超 hard，停止，不跳过它选更早的小 chunk
    expect(selection.visible).toHaveLength(0)
    expect(selection.oversize).toBeUndefined()
  })

  test("mixed CJK and ASCII estimation is conservative", () => {
    const ascii = "a".repeat(1000)
    const cjk = "汉".repeat(1000)
    const asciiTokens = SessionChunk.estimateTokens(ascii)
    const cjkTokens = SessionChunk.estimateTokens(cjk)
    expect(asciiTokens).toBe(250)
    expect(cjkTokens).toBe(1000)
  })
})

describe("project", () => {
  test("projection keeps user texts and final assistant text only", () => {
    const u1 = user("first question")
    const mid1 = assistant(u1.info.id, "thinking out loud", { finish: "tool-calls", tool: true })
    const u2 = user("steering")
    const a2 = assistant(u2.info.id, "final answer", { finish: "stop" })
    const messages = [u1, mid1, u2, a2]
    const chunk = SessionChunk.closeChunk({ messages, chunks: [] })!
    const selection = SessionChunk.selectVisible({
      messages,
      chunks: [chunk],
      targetTokens: 20_000,
      hardTokens: 24_000,
    })
    const projected = SessionChunk.project({ messages, selection })

    expect(projected).toHaveLength(3)
    expect(projected[0]!.info.id).toBe(u1.info.id)
    expect(projected[1]!.info.id).toBe(u2.info.id)
    expect(projected[2]!.info.id).toBe(a2.info.id)
    // 终态 assistant 只保留 text parts
    expect(projected[2]!.parts.every((p) => p.type === "text")).toBe(true)
    // 中间 assistant 被折叠
    expect(projected.some((m) => m.info.id === mid1.info.id)).toBe(false)
  })

  test("active tail is preserved verbatim", () => {
    const u1 = user("q1")
    const a1 = assistant(u1.info.id, "a1", { finish: "stop" })
    const chunk = SessionChunk.closeChunk({ messages: [u1, a1], chunks: [] })!
    const u2 = user("q2")
    const mid = assistant(u2.info.id, "working", { finish: "tool-calls", tool: true })
    const messages = [u1, a1, u2, mid]
    const selection = SessionChunk.selectVisible({
      messages,
      chunks: [chunk],
      targetTokens: 20_000,
      hardTokens: 24_000,
    })
    const projected = SessionChunk.project({ messages, selection })
    // tail 包含 u2 和中间 assistant（含 tool part）
    const tailIds = projected.map((m) => m.info.id)
    expect(tailIds).toEqual([u1.info.id, a1.info.id, u2.info.id, mid.info.id])
    expect(projected.at(-1)!.parts.some((p) => p.type === "tool")).toBe(true)
  })
})

describe("transcript / grep", () => {
  test("transcript covers user, assistant, tool call and output with line numbers", () => {
    const u1 = user("find the bug")
    const a1 = assistant(u1.info.id, "let me look", { finish: "tool-calls", tool: true })
    const a2 = assistant(u1.info.id, "fixed it", { finish: "stop" })
    const messages = [u1, a1, a2]
    const chunk = SessionChunk.closeChunk({ messages, chunks: [] })!
    const entries = SessionChunk.transcript({ messages, chunks: [chunk] })
    expect(entries.some((e) => e.source === "USER" && e.text === "find the bug")).toBe(true)
    expect(entries.some((e) => e.source === "ASSISTANT_TOOL" && e.text.includes("read("))).toBe(true)
    expect(entries.some((e) => e.source === "TOOL_OUTPUT" && e.text === "file contents")).toBe(true)
    expect(entries.some((e) => e.source === "ASSISTANT" && e.text === "fixed it")).toBe(true)
    // 行号连续
    entries.forEach((e, i) => expect(e.line).toBe(i))
  })

  test("grep is case-insensitive fixed-string with head limit and chunk filter", () => {
    const u1 = user("Find STOP_DETAILS here")
    const a1 = assistant(u1.info.id, "done", { finish: "stop" })
    const u2 = user("another topic")
    const a2 = assistant(u2.info.id, "ok", { finish: "stop" })
    const messages = [u1, a1, u2, a2]
    const c1 = SessionChunk.closeChunk({ messages: [u1, a1], chunks: [] })!
    const c2 = SessionChunk.closeChunk({ messages, chunks: [c1] })!

    const hits = SessionChunk.grep({
      messages,
      chunks: [c1, c2],
      pattern: "stop_details",
    })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.chunk.display_id).toBe(c1.display_id)

    const scoped = SessionChunk.grep({
      messages,
      chunks: [c1, c2],
      pattern: "stop_details",
      chunkID: c2.display_id,
    })
    expect(scoped).toHaveLength(0)
  })

  test("reasoning is not exposed in transcript", () => {
    const u1 = user("q")
    const id = mid()
    const reasoning: SessionV1.WithParts = {
      info: {
        id,
        role: "assistant",
        sessionID,
        parentID: u1.info.id,
        mode: "build",
        agent: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { output: 1, input: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: Date.now() + seq++ },
        finish: "stop",
      } as SessionV1.Assistant,
      parts: [
        {
          id: PartID.ascending(),
          messageID: id,
          sessionID,
          type: "reasoning",
          text: "secret chain of thought",
          time: { start: 0, end: 1 },
        },
        {
          id: PartID.ascending(),
          messageID: id,
          sessionID,
          type: "text",
          text: "visible",
        },
      ],
    }
    const messages = [u1, reasoning]
    const chunk = SessionChunk.closeChunk({ messages, chunks: [] })!
    const entries = SessionChunk.transcript({ messages, chunks: [chunk] })
    expect(entries.some((e) => e.text.includes("secret chain of thought"))).toBe(false)
    expect(entries.some((e) => e.text === "visible")).toBe(true)
  })
})

describe("checkpointText", () => {
  test("contains strategy marker and dynamic state", () => {
    const u1 = user("q")
    const a1 = assistant(u1.info.id, "a", { finish: "stop" })
    const chunk = SessionChunk.closeChunk({ messages: [u1, a1], chunks: [] })!
    const selection = SessionChunk.selectVisible({
      messages: [u1, a1],
      chunks: [chunk],
      targetTokens: 20_000,
      hardTokens: 24_000,
    })
    const text = SessionChunk.checkpointText({
      chunks: [chunk],
      selection,
      targetTokens: 20_000,
      hardTokens: 24_000,
    })
    expect(text).toContain(`strategy="chunk"`)
    expect(text).toContain("visible chunks: 1")
    expect(text).toContain("archived chunks: 0")
    expect(text).toContain("history_grep")
  })
})
