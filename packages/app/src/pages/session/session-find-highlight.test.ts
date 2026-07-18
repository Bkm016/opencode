import { describe, expect, test } from "bun:test"
import { clearSessionFindHighlights, supportsSessionFindHighlight } from "./session-find-highlight"

describe("session-find-highlight", () => {
  test("supportsSessionFindHighlight is boolean in current runtime", () => {
    expect(typeof supportsSessionFindHighlight()).toBe("boolean")
  })

  test("clearSessionFindHighlights is safe without Highlight API", () => {
    expect(() => clearSessionFindHighlights()).not.toThrow()
  })
})
