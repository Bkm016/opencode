import { describe, expect, test } from "bun:test"
import { detectRepetition } from "../../src/session/repetition"

describe("session.repetition.detectRepetition", () => {
  test("requires three complete long cycles", () => {
    const sentence = "The quick brown fox jumps over the lazy dog near the riverbank now."
    expect(detectRepetition(sentence.repeat(2))).toBe(false)
    expect(detectRepetition(sentence.repeat(3))).toBe(true)
  })

  test("detects a compact pattern only after it becomes a long loop", () => {
    expect(detectRepetition("the ".repeat(20))).toBe(false)
    expect(detectRepetition("the ".repeat(100))).toBe(true)
  })

  test("ignores near repetition", () => {
    const base = "The quick brown fox jumps over the lazy dog near the riverbank now."
    const text = base + "1" + base + "2" + base + "3"
    expect(detectRepetition(text)).toBe(false)
  })
})
