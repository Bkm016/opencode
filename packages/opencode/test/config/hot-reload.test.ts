import { expect } from "bun:test"
import { isConfigHotReloadPath } from "../../src/config/hot-reload"
import { test } from "bun:test"

test("isConfigHotReloadPath matches config, skill, plugin, agent, command paths", () => {
  expect(isConfigHotReloadPath("/proj/opencode.json")).toBe(true)
  expect(isConfigHotReloadPath("C:\\Users\\x\\.config\\opencode\\opencode.jsonc")).toBe(true)
  expect(isConfigHotReloadPath("/proj/.opencode/skill/foo/SKILL.md")).toBe(true)
  expect(isConfigHotReloadPath("/proj/.opencode/skills/bar/SKILL.md")).toBe(true)
  expect(isConfigHotReloadPath("/proj/.opencode/plugin/hook.ts")).toBe(true)
  expect(isConfigHotReloadPath("/proj/.opencode/plugins/hook.js")).toBe(true)
  expect(isConfigHotReloadPath("/proj/.opencode/agent/review.md")).toBe(true)
  expect(isConfigHotReloadPath("/proj/.opencode/command/ship.md")).toBe(true)
  expect(isConfigHotReloadPath("/home/x/.claude/skills/foo/SKILL.md")).toBe(true)
})

test("isConfigHotReloadPath ignores noise and non-config files", () => {
  expect(isConfigHotReloadPath("/proj/src/index.ts")).toBe(false)
  expect(isConfigHotReloadPath("/proj/.opencode/node_modules/x/index.js")).toBe(false)
  expect(isConfigHotReloadPath("/proj/.opencode/.gitignore")).toBe(false)
  expect(isConfigHotReloadPath("/proj/.opencode/bun.lock")).toBe(false)
  expect(isConfigHotReloadPath("/proj/.opencode/package.json")).toBe(false)
  expect(isConfigHotReloadPath("/proj/README.md")).toBe(false)
})
