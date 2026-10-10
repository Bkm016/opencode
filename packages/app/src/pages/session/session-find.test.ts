import { describe, expect, test } from "bun:test"
import { findHitFilter, findHitKey, findPreviewLines, orderFindHits, type SessionFindHit } from "./session-find"

const hit = (userMessageID: string, partID: string, ordinal = 0): SessionFindHit => ({
  messageID: userMessageID,
  partID,
  userMessageID,
  turn: 1,
  role: "user",
  kind: "text",
  ordinal,
  start: 0,
  end: 1,
  line: 1,
  before: "",
  match: "x",
  after: "",
  compacted: false,
  time: 0,
})

describe("orderFindHits", () => {
  test("newest first", () => {
    const hits = [hit("msg_1", "prt_a"), hit("msg_2", "prt_b"), hit("msg_3", "prt_c")]
    expect(orderFindHits(hits).map((item) => item.partID)).toEqual(["prt_c", "prt_b", "prt_a"])
    // 不改动入参
    expect(hits[0]!.partID).toBe("prt_a")
  })

  test("drops reverted turns", () => {
    const hits = [hit("msg_1", "prt_a"), hit("msg_2", "prt_b"), hit("msg_3", "prt_c")]
    expect(orderFindHits(hits, "msg_2").map((item) => item.partID)).toEqual(["prt_a"])
  })
})

describe("findHitKey", () => {
  test("distinguishes occurrences within one part", () => {
    expect(findHitKey(hit("msg_1", "prt_a", 0))).not.toBe(findHitKey(hit("msg_1", "prt_a", 1)))
  })
})

describe("findHitFilter", () => {
  test("splits text by role", () => {
    expect(findHitFilter(hit("msg_1", "prt_a"))).toBe("user")
    expect(findHitFilter({ ...hit("msg_1", "prt_a"), role: "assistant" })).toBe("assistant")
    expect(findHitFilter({ ...hit("msg_1", "prt_a"), kind: "file" })).toBe("other")
  })
})

describe("findPreviewLines", () => {
  test("marks hits per line and the active one", () => {
    const text = "aa foo\nbar\nfoo foo"
    const ranges = [
      { start: 3, end: 6 },
      { start: 11, end: 14 },
      { start: 15, end: 18 },
    ]
    const result = findPreviewLines(text, ranges, ranges[2]!)
    expect(result.activeLine).toBe(3)
    expect(result.lines.map((line) => line.segments.map((s) => `${s.mark ?? "-"}:${s.text}`))).toEqual([
      ["-:aa ", "hit:foo"],
      ["-:bar"],
      ["hit:foo", "-: ", "active:foo"],
    ])
  })

  test("windows around the active line", () => {
    const text = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n")
    const start = text.indexOf("line 500")
    const result = findPreviewLines(text, [{ start, end: start + 4 }], { start, end: start + 4 }, 10)
    expect(result.lines.length).toBe(21)
    expect(result.lines[0]!.no).toBe(491)
    expect(result.clippedStart && result.clippedEnd).toBe(true)
  })
})
