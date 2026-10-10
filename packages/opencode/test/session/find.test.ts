import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionFind } from "../../src/session/find"

const sessionID = "ses_1"
const user = (id: string, parts: unknown[]) =>
  ({
    info: { id, sessionID, role: "user", time: { created: 1 }, model: { providerID: "p", modelID: "m" } },
    parts: parts.map((part, index) => ({ id: `prt_${id}_${index}`, sessionID, messageID: id, ...(part as object) })),
  }) as unknown as SessionV1.WithParts
const assistant = (id: string, parentID: string, parts: unknown[], extra: object = {}) =>
  ({
    info: { id, sessionID, role: "assistant", parentID, time: { created: 2 }, ...extra },
    parts: parts.map((part, index) => ({ id: `prt_${id}_${index}`, sessionID, messageID: id, ...(part as object) })),
  }) as unknown as SessionV1.WithParts

const messages = [
  user("msg_01", [{ type: "text", text: "修复 Foo 组件" }]),
  assistant("msg_02", "msg_01", [
    { type: "reasoning", text: "看看 foo 在哪" },
    {
      type: "tool",
      tool: "bash",
      callID: "c",
      state: { status: "completed", input: { command: "grep foo src" }, output: "src/a.ts: foo()\nsrc/b.ts: foo()", title: "grep", metadata: {}, time: { start: 1, end: 2 } },
    },
  ]),
  user("msg_03", [{ type: "compaction", auto: true }]),
  assistant("msg_04", "msg_03", [{ type: "text", text: "摘要：修了 foo" }], { summary: true }),
  user("msg_05", [{ type: "text", text: "继续 foo", synthetic: false }, { type: "text", text: "foo 合成", synthetic: true }]),
]

describe("SessionFind.find", () => {
  test("searches every part kind, case-insensitive by default", () => {
    const result = SessionFind.find({ messages, query: "foo" })
    expect(result.total).toBe(7)
    expect(result.hits.map((hit) => hit.kind)).toEqual(["text", "reasoning", "tool", "tool", "tool", "summary", "text"])
    expect(result.hits[2]).toMatchObject({ tool: "bash", ordinal: 0, userMessageID: "msg_01" })
    expect(result.hits[4].ordinal).toBe(2)
  })

  test("marks messages before the latest compaction", () => {
    const result = SessionFind.find({ messages, query: "foo" })
    expect(result.hits.filter((hit) => hit.compacted).map((hit) => hit.messageID)).toEqual([
      "msg_01",
      "msg_02",
      "msg_02",
      "msg_02",
      "msg_02",
    ])
  })

  test("case sensitive and limit", () => {
    expect(SessionFind.find({ messages, query: "Foo", caseSensitive: true }).total).toBe(1)
    const limited = SessionFind.find({ messages, query: "foo", limit: 2 })
    expect(limited.hits.length).toBe(2)
    expect(limited.truncated).toBe(true)
  })

  test("turn, line and offsets", () => {
    const result = SessionFind.find({ messages, query: "foo" })
    expect(result.hits.map((hit) => hit.turn)).toEqual([1, 1, 1, 1, 1, 2, 3])
    // bash 输出第二行里的 foo
    const tool = result.hits.filter((hit) => hit.kind === "tool")
    expect(tool.map((hit) => hit.line)).toEqual([2, 3, 4])
    expect(tool[0]!.end - tool[0]!.start).toBe(3)
  })

  test("regex and whole word", () => {
    expect(SessionFind.find({ messages, query: "fo+\\(\\)", regex: true }).total).toBe(2)
    expect(SessionFind.find({ messages, query: "(", regex: true }).error).toBeString()
    expect(SessionFind.find({ messages, query: "z*", regex: true }).total).toBe(0)
    const word = SessionFind.find({
      messages: [user("msg_01", [{ type: "text", text: "foo foobar 中foo文 _foo" }])],
      query: "foo",
      word: true,
    })
    expect(word.hits.map((hit) => hit.start)).toEqual([0])
  })

  test("snippet is single-line and clipped", () => {
    const long = "x".repeat(300)
    const result = SessionFind.find({
      messages: [user("msg_01", [{ type: "text", text: `${long}\n\nneedle\n${long}` }])],
      query: "needle",
    })
    const hit = result.hits[0]
    expect(hit.before.startsWith("…")).toBe(true)
    expect(hit.after.endsWith("…")).toBe(true)
    expect(hit.before.includes("\n")).toBe(false)
    expect(hit.match).toBe("needle")
  })
})
