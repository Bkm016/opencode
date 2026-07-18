import type { LspStatus, McpStatus } from "@opencode-ai/sdk/v2/client"
import { getFilename } from "@opencode-ai/core/util/path"

export function hasNonBlockingServiceIssue(input: {
  mcp: Array<McpStatus["status"]>
  lsp: Array<LspStatus["status"]>
}) {
  return (
    input.mcp.some((status) => status !== "connected" && status !== "disabled") ||
    input.lsp.some((status) => status === "error")
  )
}

export function serverStatusDotClass(input: { ready: boolean; serverHealth: boolean | undefined; issue: boolean }) {
  if (input.serverHealth === false) return "bg-icon-critical-base"
  if (!input.ready || input.serverHealth === undefined) return "bg-border-weak-base"
  if (input.issue) return "bg-icon-warning-base"
  if (input.serverHealth === true) return "bg-icon-success-base"
  return "bg-border-weak-base"
}

/** Resolve a plugin file:// specifier to a filesystem path for display/open. */
export function pluginFilePath(spec: string) {
  if (!spec.startsWith("file://")) return
  try {
    let path = decodeURIComponent(spec.slice("file://".length))
    if (/^\/[a-zA-Z]:/.test(path)) path = path.slice(1)
    return path
  } catch {
    return
  }
}

/** Short label for status popover: basename for local plugins, raw spec otherwise. */
export function pluginLabel(spec: string) {
  const path = pluginFilePath(spec)
  if (!path) return spec
  const name = getFilename(path) || path
  return `local: ${name}`
}
