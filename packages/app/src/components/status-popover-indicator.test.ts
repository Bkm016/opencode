import { describe, expect, test } from "bun:test"
import {
  hasNonBlockingServiceIssue,
  pluginFilePath,
  pluginLabel,
  serverStatusDotClass,
} from "./status-popover-indicator"

describe("serverStatusDotClass", () => {
  test("uses the success token while the server and services are healthy", () => {
    expect(serverStatusDotClass({ ready: true, serverHealth: true, issue: false })).toBe("bg-icon-success-base")
  })

  test("uses the warning token for non-blocking issues while the server is online", () => {
    expect(serverStatusDotClass({ ready: true, serverHealth: true, issue: true })).toBe("bg-icon-warning-base")
  })

  test("uses the critical token only after the server connection drops", () => {
    expect(serverStatusDotClass({ ready: true, serverHealth: false, issue: false })).toBe("bg-icon-critical-base")
    expect(serverStatusDotClass({ ready: true, serverHealth: false, issue: true })).toBe("bg-icon-critical-base")
  })

  test("stays neutral before status is ready", () => {
    expect(serverStatusDotClass({ ready: false, serverHealth: true, issue: false })).toBe("bg-border-weak-base")
    expect(serverStatusDotClass({ ready: false, serverHealth: undefined, issue: false })).toBe("bg-border-weak-base")
  })
})

describe("hasNonBlockingServiceIssue", () => {
  test("detects MCP failures that do not block chatting", () => {
    expect(hasNonBlockingServiceIssue({ mcp: ["failed"], lsp: [] })).toBe(true)
    expect(hasNonBlockingServiceIssue({ mcp: ["needs_auth"], lsp: [] })).toBe(true)
    expect(hasNonBlockingServiceIssue({ mcp: ["needs_client_registration"], lsp: [] })).toBe(true)
    expect(hasNonBlockingServiceIssue({ mcp: ["connected", "disabled"], lsp: [] })).toBe(false)
  })

  test("detects LSP failures that do not block chatting", () => {
    expect(hasNonBlockingServiceIssue({ mcp: [], lsp: ["error"] })).toBe(true)
    expect(hasNonBlockingServiceIssue({ mcp: [], lsp: ["connected"] })).toBe(false)
  })
})

describe("pluginLabel", () => {
  test("keeps npm package specs unchanged", () => {
    expect(pluginLabel("opencode-wakatime@1.3.0")).toBe("opencode-wakatime@1.3.0")
  })

  test("shows a local prefix and basename for file plugins", () => {
    expect(pluginLabel("file:///C:/Users/sky/.config/opencode/plugin/foo.ts")).toBe("local: foo.ts")
    expect(pluginLabel("file:///home/user/.config/opencode/plugin/bar.js")).toBe("local: bar.js")
  })

  test("decodes percent-encoded path segments", () => {
    expect(pluginLabel("file:///C:/Users/sky/.config/opencode/plugin/my%20plugin.ts")).toBe("local: my plugin.ts")
  })
})

describe("pluginFilePath", () => {
  test("returns undefined for non-file specs", () => {
    expect(pluginFilePath("opencode-wakatime@1.3.0")).toBeUndefined()
  })

  test("strips the file URL prefix and Windows drive slash", () => {
    expect(pluginFilePath("file:///C:/Users/sky/.config/opencode/plugin/foo.ts")).toBe(
      "C:/Users/sky/.config/opencode/plugin/foo.ts",
    )
  })
})
