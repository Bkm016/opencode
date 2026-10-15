import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionEnhance } from "../../src/session/enhance"
import { SessionSuggest } from "../../src/session/suggest"

function message(role: "user" | "assistant", parts: unknown[]) {
  return { info: { role }, parts } as unknown as SessionV1.WithParts
}

describe("SessionSuggest.clean", () => {
  test("takes the first line and strips quotes and prefixes", () => {
    expect(SessionSuggest.clean("  \"跑一下测试\"\n因为刚改完代码")).toBe("跑一下测试")
    expect(SessionSuggest.clean("建议：提交")).toBe("提交")
    expect(SessionSuggest.clean("Suggestion: run the tests")).toBe("run the tests")
    expect(SessionSuggest.clean("「继续」")).toBe("继续")
  })

  test("drops empty, NONE and overlong output", () => {
    expect(SessionSuggest.clean("")).toBeUndefined()
    expect(SessionSuggest.clean("  \n ")).toBeUndefined()
    expect(SessionSuggest.clean("NONE")).toBeUndefined()
    expect(SessionSuggest.clean("none")).toBeUndefined()
    expect(SessionSuggest.clean("x".repeat(200))).toBeUndefined()
  })
})

describe("SessionEnhance.transcript notices", () => {
  const messages = [
    message("user", [
      { type: "text", text: '<peer-message from="@brave-wolf" session="ses_1" hops="1">\nv95 不是我改的\n</peer-message>', synthetic: true },
      { type: "text", text: "<system-reminder>noise</system-reminder>", synthetic: true },
      { type: "text", text: '<task id="ses_2" state="completed"><task_result>done</task_result></task>', synthetic: true },
    ]),
    message("assistant", [{ type: "text", text: "收到" }]),
  ]

  test("drops synthetic text by default", () => {
    expect(SessionEnhance.transcript(messages)).toBe("Agent:\n收到")
  })

  test("keeps peer messages and task notices, not other synthetic text, when asked", () => {
    const result = SessionEnhance.transcript(messages, { notices: true })
    expect(result).toContain("v95 不是我改的")
    expect(result).toContain("<task id=")
    expect(result).not.toContain("noise")
  })
})
