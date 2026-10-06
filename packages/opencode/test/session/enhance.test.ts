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
})
