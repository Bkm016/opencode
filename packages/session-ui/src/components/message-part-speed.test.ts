import { describe, expect, test } from "bun:test"
import { CHARS_PER_TOKEN, estimateOutputTokens, formatSpeed, speedFromTokens } from "./message-part-speed"

describe("estimateOutputTokens", () => {
  test("returns zero for empty text", () => {
    expect(estimateOutputTokens("")).toBe(0)
  })

  test("folds characters at four per token", () => {
    expect(estimateOutputTokens("abcd".repeat(10))).toBe(40 / CHARS_PER_TOKEN)
  })
})

describe("speedFromTokens", () => {
  test("converts tokens and elapsed time to tok/s and ms/tok", () => {
    expect(speedFromTokens(25, 1000)).toEqual({ tps: 25, tpotMs: 40 })
  })

  test("rejects non-positive inputs", () => {
    expect(speedFromTokens(0, 1000)).toBeUndefined()
    expect(speedFromTokens(10, 0)).toBeUndefined()
    expect(speedFromTokens(-5, 1000)).toBeUndefined()
  })
})

describe("formatSpeed", () => {
  test("renders both tok/s and ms/tok", () => {
    expect(formatSpeed(25.25, 39.6, (value) => value.toFixed(1))).toBe("25.3 tok/s · 39.6ms/tok")
  })
})
