import { describe, expect, test } from "bun:test"
import { RunScript } from "@opencode-ai/core/run-script"

const filepath = "/project/.opencode/run.json"

describe("RunScript.parse", () => {
  test("parses the canonical scripts object", () => {
    expect(RunScript.parse(filepath, { scripts: { dev: "bun dev", pgsql: "npm start" } })).toEqual({
      dev: "bun dev",
      pgsql: "npm start",
    })
  })

  test("parses a bare top-level script map", () => {
    expect(RunScript.parse(filepath, { dev: "bun dev" })).toEqual({ dev: "bun dev" })
  })

  test("ignores the $schema hint", () => {
    expect(RunScript.parse(filepath, { $schema: "https://example.com/schema.json", dev: "bun dev" })).toEqual({
      dev: "bun dev",
    })
  })

  test("fails on non-object input", () => {
    expect(() => RunScript.parse(filepath, "nope")).toThrow(RunScript.ParseError)
    expect(() => RunScript.parse(filepath, null)).toThrow(RunScript.ParseError)
    expect(() => RunScript.parse(filepath, ["dev"])).toThrow(RunScript.ParseError)
  })

  test("fails when scripts is not a string map", () => {
    expect(() => RunScript.parse(filepath, { scripts: "nope" })).toThrow(RunScript.ParseError)
    expect(() => RunScript.parse(filepath, { scripts: { dev: 42 } })).toThrow(RunScript.ParseError)
  })

  test("error message carries the file path and reason", () => {
    try {
      RunScript.parse(filepath, { scripts: { dev: 42 } })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(RunScript.ParseError)
      expect((error as Error).message).toContain(filepath)
      expect((error as Error).message).toContain('"dev"')
    }
  })
})
