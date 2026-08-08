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
    const err = new SessionV1.APIError({ message: "boom", isRetryable: true }).toObject()
    const a1 = assistant(u1.info.id, "partial", { finish: "error", error: err })
    expect(SessionChunk.closeChunk({ messages: [u1, a1], chunks: [] })).toBeUndefined()

    const a2 = assistant(u1.info.id, "blocked", { finish: "content-filter" })
    expect(SessionChunk.closeChunk({ messages: [u1, a2], chunks: [] })!.status).toBe("failed")

    const a3 = assistant(u1.info.id, "long", { finish: "length" })
    expect(SessionChunk.closeChunk({ messages: [u1, a3], chunks: [] })!.status).toBe("failed")
  })

  test("closes an overflow-delimited turn without error object as interrupted", () => {
    const u1 = user("hello")
    // overflow 封存标记：finish=error 且无 error 对象，turn 已终止、必须可关闭
    const a1 = assistant(u1.info.id, "partial", { finish: "error" })
    const chunk = SessionChunk.closeChunk({ messages: [u1, a1], chunks: [] })
    expect(chunk).toBeDefined()
    expect(chunk!.status).toBe("interrupted")
    expect(chunk!.end_message_id).toBe(a1.info.id)
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

  test("closes first stop boundary, not entire multi-turn region", () => {
    const u1 = user("a")
    const a1 = assistant(u1.info.id, "a1", { finish: "stop" })
    const u2 = user("b")
    const a2 = assistant(u2.info.id, "b2", { finish: "stop" })
    const u3 = user("c")
    const a3 = assistant(u3.info.id, "c3", { finish: "stop" })
    const messages = [u1, a1, u2, a2, u3, a3]
    const first = SessionChunk.closeChunk({ messages, chunks: [] })!
    expect(first.start_message_id).toBe(u1.info.id)
    expect(first.end_message_id).toBe(a1.info.id)
    const second = SessionChunk.closeChunk({ messages, chunks: [first] })!
    expect(second.start_message_id).toBe(u2.info.id)
    expect(second.end_message_id).toBe(a2.info.id)
    const third = SessionChunk.closeChunk({ messages, chunks: [first, second] })!
    expect(third.start_message_id).toBe(u3.info.id)
    expect(third.end_message_id).toBe(a3.info.id)
    expect(SessionChunk.closeChunk({ messages, chunks: [first, second, third] })).toBeUndefined()
  })

  test("tool-call intermediate assistant stays inside one chunk until stop", () => {
    const u1 = user("read file")
    const a1 = assistant(u1.info.id, "", { finish: "tool-calls", tool: true })
    const a2 = assistant(u1.info.id, "done", { finish: "stop" })
    const messages = [u1, a1, a2]
    const chunk = SessionChunk.closeChunk({ messages, chunks: [] })!
    expect(chunk.start_message_id).toBe(u1.info.id)
    expect(chunk.end_message_id).toBe(a2.info.id)
  })

  test("re-compaction closes second-round turns after prior scaffold", () => {
    const u1 = user("round1")
    const a1 = assistant(u1.info.id, "done1", { finish: "stop" })
    const first = SessionChunk.closeChunk({ messages: [u1, a1], chunks: [] })!
    // 上一轮 compaction holder + summary（finish=stop 但不可关进新 chunk）
    const holderID = mid()
    const holder: SessionV1.WithParts = {
      info: {
        id: holderID,
        role: "user",
        sessionID,
        agent: "compaction",
        model: ref,
        time: { created: Date.now() + seq++ },
      },
      parts: [
        {
          id: PartID.ascending(),
          messageID: holderID,
          sessionID,
          type: "compaction",
          auto: false,
          chunks: [first],
          tail_start_id: undefined,
        } as SessionV1.CompactionPart,
      ],
    }
    const summaryID = mid()
    const summary: SessionV1.WithParts = {
      info: {
        id: summaryID,
        role: "assistant",
        sessionID,
        parentID: holderID,
        mode: "compaction",
        agent: "compaction",
        summary: true,
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: Date.now() + seq++, completed: Date.now() + seq },
        finish: "stop",
      } as SessionV1.Assistant,
      parts: [
        {
          id: PartID.ascending(),
          messageID: summaryID,
          sessionID,
          type: "text",
          text: "folded",
        },
      ],
    }
    const u2 = user("round2 question")
    const a2 = assistant(u2.info.id, "round2 answer", { finish: "stop" })
    const u3 = user("round2 more")
    const a3 = assistant(u3.info.id, "round2 final", { finish: "stop" })
    const messages = [u1, a1, holder, summary, u2, a2, u3, a3]
    const second = SessionChunk.closeChunk({ messages, chunks: [first] })!
    expect(second.start_message_id).toBe(u2.info.id)
    expect(second.end_message_id).toBe(a2.info.id)
    const third = SessionChunk.closeChunk({ messages, chunks: [first, second] })!
    expect(third.start_message_id).toBe(u3.info.id)
    expect(third.end_message_id).toBe(a3.info.id)
    // summary 脚手架本身不能被关成 chunk
    expect(SessionChunk.closeChunk({ messages: [u1, a1, holder, summary], chunks: [first] })).toBeUndefined()
  })

  test("trailing /compact command does not swallow prior stop boundary", () => {
    const u1 = user("hello")
    const a1 = assistant(u1.info.id, "world", { finish: "stop" })
    // /compact 命令消息（user + compaction part，无 chunks）
    const compactCmdId = mid()
    const compactCmd: SessionV1.WithParts = {
      info: {
        id: compactCmdId,
        role: "user",
        sessionID,
        agent: "build",
        model: ref,
        time: { created: Date.now() + seq++ },
      },
      parts: [
        {
          id: PartID.ascending(),
          messageID: compactCmdId,
          sessionID,
          type: "compaction",
          auto: false,
        } as SessionV1.CompactionPart,
      ],
    }
    // 开放区间取第一个 stop，尾部 /compact 用户消息不并入该 chunk
    const chunk = SessionChunk.closeChunk({ messages: [u1, a1, compactCmd], chunks: [] })
    expect(chunk).toBeDefined()
    expect(chunk!.start_message_id).toBe(u1.info.id)
    expect(chunk!.end_message_id).toBe(a1.info.id)
    // 之后只剩 /compact 脚手架，无可关闭边界
    expect(SessionChunk.closeChunk({ messages: [u1, a1, compactCmd], chunks: [chunk!] })).toBeUndefined()
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

  test("projects user text over hard budget to a stable reference", () => {
    const bigUser = "汉".repeat(30_000)
    const { messages, chunks } = build(1, bigUser, "ok")
    const selection = SessionChunk.selectVisible({
      messages,
      chunks,
      targetTokens: 20_000,
      hardTokens: 24_000,
    })
    expect(selection.visible).toHaveLength(1)
    const projected = SessionChunk.project({ messages, selection, targetTokens: 20_000, hardTokens: 24_000 })
    const input = (projected[1]!.parts[0] as SessionV1.TextPart).text
    expect(input).toContain("<user-text-reference")
    expect(input).toContain(`message_id="${messages[0]!.info.id}"`)
    expect(input).toContain(`part_id="${messages[0]!.parts[0]!.id}"`)
    expect(input).not.toContain(bigUser)
    const persistedSummary = SessionChunk.summaryText({ messages, chunks })
    expect(persistedSummary).toContain("<user-text-reference")
    expect(persistedSummary).not.toContain(bigUser)
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
    const projected = SessionChunk.project({ messages, selection, targetTokens: 20_000, hardTokens: 24_000 })

    // checkpoint + chunk-input + chunk-summary = 3
    expect(projected).toHaveLength(3)
    expect(projected[0]!.info.role).toBe("user")
    expect(projected[1]!.info.role).toBe("user")
    expect(projected[2]!.info.role).toBe("assistant")
    // chunk-input 包含两条 user 原文
    const inputText = (projected[1]!.parts[0] as any).text as string
    expect(inputText).toContain("first question")
    expect(inputText).toContain("steering")
    // chunk-summary 包含 final answer
    const summaryText = (projected[2]!.parts[0] as any).text as string
    expect(summaryText).toContain("final answer")
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
    const projected = SessionChunk.project({ messages, selection, targetTokens: 20_000, hardTokens: 24_000 })
    // checkpoint + chunk-input + chunk-summary + tail(u2 + mid) = 5
    const tailPart = projected.slice(3)
    expect(tailPart.some((m) => m.info.id === u2.info.id)).toBe(true)
    expect(tailPart.some((m) => m.info.id === mid.info.id)).toBe(true)
    expect(tailPart.at(-1)!.parts.some((p) => p.type === "tool")).toBe(true)
  })

  test("projects a long active user text as a reference without dropping the active message", () => {
    const u1 = user("q1")
    const a1 = assistant(u1.info.id, "a1", { finish: "stop" })
    const chunk = SessionChunk.closeChunk({ messages: [u1, a1], chunks: [] })!
    const longText = "error: " + "details\n".repeat(30_000)
    const u2 = user(longText)
    const active = assistant(u2.info.id, "working", { finish: "tool-calls", tool: true })
    const messages = [u1, a1, u2, active]
    const selection = SessionChunk.selectVisible({
      messages,
      chunks: [chunk],
      targetTokens: 20_000,
      hardTokens: 24_000,
    })
    const projected = SessionChunk.project({ messages, selection, targetTokens: 20_000, hardTokens: 24_000 })
    const projectedUser = projected.find((message) => message.info.id === u2.info.id)!
    const text = (projectedUser.parts[0] as SessionV1.TextPart).text

    expect(text).not.toBe(longText)
    expect(text).toContain(`<user-text-reference message_id="${u2.info.id}"`)
    expect(text).toContain("error: details")
    expect((u2.parts[0] as SessionV1.TextPart).text).toBe(longText)
    expect(projected.some((message) => message.info.id === active.info.id)).toBe(true)
  })

  test("archived chunks and checkpoint summaries do not leak into an active tail", () => {
    const u1 = user("old request")
    const a1 = assistant(u1.info.id, "old answer", { finish: "stop" })
    const chunk = SessionChunk.closeChunk({ messages: [u1, a1], chunks: [] })!
    const holderID = mid()
    const holder: SessionV1.WithParts = {
      info: {
        id: holderID,
        role: "user",
        sessionID,
        agent: "compaction",
        model: ref,
        time: { created: Date.now() + seq++ },
      },
      parts: [
        {
          id: PartID.ascending(),
          messageID: holderID,
          sessionID,
          type: "compaction",
          auto: true,
          chunks: [chunk],
        },
      ],
    }
    const summary = assistant(holderID, "oversized persisted checkpoint", { finish: "stop" })
    if (summary.info.role !== "assistant") throw new Error("Expected assistant summary")
    summary.info.summary = true
    const u2 = user("current request")
    const active = assistant(u2.info.id, "current work", { finish: "tool-calls", tool: true })
    const messages = [u1, a1, holder, summary, u2, active]
    const projected = SessionChunk.project({
      messages,
      selection: { visible: [], archived: [chunk], tokens: 0 },
      targetTokens: 20_000,
      hardTokens: 24_000,
    })

    expect(projected.some((message) => message.info.id === u1.info.id)).toBe(false)
    expect(projected.some((message) => message.info.id === holder.info.id)).toBe(false)
    expect(projected.some((message) => message.info.id === summary.info.id)).toBe(false)
    expect(projected.some((message) => message.info.id === u2.info.id)).toBe(true)
    expect(projected.some((message) => message.info.id === active.info.id)).toBe(true)
  })
})

describe("transcript / grep", () => {
  test("reads referenced user text by stable message and part IDs", () => {
    const message = user("first line\nneedle\nlast line")
    const part = message.parts[0]!
    const entries = SessionChunk.userTextTranscript({
      messages: [message],
      messageID: String(message.info.id),
      partID: String(part.id),
    })

    expect(entries.map((entry) => entry.text)).toEqual(["first line", "needle", "last line"])
    expect(entries.every((entry) => entry.messageID === String(message.info.id))).toBe(true)
    expect(entries.every((entry) => entry.partID === String(part.id))).toBe(true)
    expect(SessionChunk.formatUserTextTranscript(entries)).toContain(`0 USER message=${message.info.id} part=${part.id}:`)
  })

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

  test("formats consecutive transcript sources once", () => {
    const u1 = user("first line\nsecond line")
    const a1 = assistant(u1.info.id, "done", { finish: "stop" })
    const messages = [u1, a1]
    const chunk = SessionChunk.closeChunk({ messages, chunks: [] })!
    const entries = SessionChunk.transcript({ messages, chunks: [chunk] })

    expect(SessionChunk.formatTranscript(entries)).toBe("0 USER: first line\n1: second line\n2 ASSISTANT: done")
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
    expect(hits[0]!.context.some((entry) => entry.line === hits[0]!.line)).toBe(false)

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
