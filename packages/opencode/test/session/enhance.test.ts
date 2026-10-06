import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionEnhance } from "../../src/session/enhance"

function message(role: "user" | "assistant", parts: unknown[]) {
  return { info: { role }, parts } as unknown as SessionV1.WithParts
}

describe("SessionEnhance.transcript", () => {
  test("keeps text, file names and tool targets", () => {
    const result = SessionEnhance.transcript([
      message("user", [
        { type: "text", text: "幽灵按钮对比度不够" },
        { type: "text", text: "<system-reminder>", synthetic: true },
        { type: "file", filename: "shot.png", url: "data:," },
      ]),
      message("assistant", [
        { type: "reasoning", text: "thinking" },
        { type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "src/styles/tokens.css" } } },
        { type: "tool", tool: "bash", state: { status: "pending" } },
        { type: "text", text: "改好了" },
      ]),
    ])
    expect(result).toBe(
      "User:\n幽灵按钮对比度不够\n[file: shot.png]\n\nAgent:\n[edit: src/styles/tokens.css]\n[bash]\n改好了",
    )
  })

  test("drops the oldest messages once over the limit", () => {
    const long = "x".repeat(1400)
    const messages = Array.from({ length: 12 }, (_, index) =>
      message("user", [{ type: "text", text: `${index} ${long}` }]),
    )
    const result = SessionEnhance.transcript(messages)
    expect(result.length).toBeLessThanOrEqual(12_000 + 2 * 12)
    expect(result).toContain("11 x")
    expect(result).not.toContain("User:\n0 x")
  })
})

describe("SessionEnhance.request", () => {
  test("wraps the draft and optional history", () => {
    expect(SessionEnhance.request("修一下", "")).toBe("Draft message to rewrite:\n<draft>\n修一下\n</draft>")
    expect(SessionEnhance.request("修一下", "User:\nhi")).toContain("<conversation>\nUser:\nhi\n</conversation>")
  })

  test("appends answers to clarifying questions", () => {
    const result = SessionEnhance.request("修一下", "", {
      answers: [
        { question: "哪个按钮？", answer: "幽灵按钮" },
        { question: "要兼容暗色吗？", answer: " " },
      ],
    })
    expect(result).toEndWith(
      "<answers>\nQ: 哪个按钮？\nA: 幽灵按钮\nQ: 要兼容暗色吗？\nA: (no answer, leave it open)\n</answers>",
    )
    expect(result).toContain("do not ask again")
  })

  test("tells the model not to ask without a session", () => {
    expect(SessionEnhance.request("修一下", "", { ask: false })).toEndWith("Rewrite now; do not ask.")
  })
})

describe("SessionEnhance.parseQuestions", () => {
  test("reads questions and their options", () => {
    const output = "<questions>\nQ: 指的是哪个状态？\n- hover\n- focus\nQ: 暗色主题也要改吗？\n</questions>"
    expect(SessionEnhance.parseQuestions(output)).toEqual([
      { question: "指的是哪个状态？", options: ["hover", "focus"] },
      { question: "暗色主题也要改吗？", options: [] },
    ])
  })

  test("accepts numbered questions and a missing closing tag", () => {
    expect(SessionEnhance.parseQuestions("<questions>\n1. Which file?\n* a.ts\n2) Keep the API?")).toEqual([
      { question: "Which file?", options: ["a.ts"] },
      { question: "Keep the API?", options: [] },
    ])
  })

  test("caps questions and options", () => {
    const options = Array.from({ length: 6 }, (_, index) => `- ${index}`).join("\n")
    const body = Array.from({ length: 5 }, (_, index) => `Q: q${index}\n${options}`).join("\n")
    const result = SessionEnhance.parseQuestions(`<questions>\n${body}\n</questions>`)!
    expect(result).toHaveLength(3)
    expect(result[0].options).toEqual(["0", "1", "2", "3"])
  })

  test("ignores normal rewrites and empty blocks", () => {
    expect(SessionEnhance.parseQuestions("检查 @src/Button.tsx")).toBeUndefined()
    expect(SessionEnhance.parseQuestions("<questions>\n</questions>")).toBeUndefined()
  })
})
