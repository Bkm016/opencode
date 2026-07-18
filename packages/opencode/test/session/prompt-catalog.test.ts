import { describe, expect, test } from "bun:test"
import { PromptCatalog } from "../../src/session/prompt-catalog"

describe("PromptCatalog", () => {
  test("resolve returns catalog default when override is missing or empty", () => {
    const fallback = PromptCatalog.getDefault("system.default")
    expect(fallback).toBeTruthy()
    expect(typeof fallback).toBe("string")
    expect(PromptCatalog.resolve("system.default")).toBe(fallback!)
    expect(PromptCatalog.resolve("system.default", {})).toBe(fallback!)
    expect(PromptCatalog.resolve("system.default", { "system.default": "" })).toBe(fallback!)
  })

  test("resolve prefers non-empty override", () => {
    expect(PromptCatalog.resolve("agent.explore", { "agent.explore": "custom explore" })).toBe("custom explore")
  })

  test("catalog marks overridden entries", () => {
    const list = PromptCatalog.catalog({
      "command.init": "init override",
      "tool.read": "",
    })
    const init = list.find((entry) => entry.id === "command.init")
    const read = list.find((entry) => entry.id === "tool.read")
    expect(init?.value).toBe("init override")
    expect(init?.overridden).toBe(true)
    expect(read?.value).toBe(PromptCatalog.getDefault("tool.read"))
    expect(read?.overridden).toBe(false)
    expect(list.length).toBe(PromptCatalog.ENTRIES.length)
  })
})
