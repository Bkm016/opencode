import type { Part, ToolPart } from "@opencode-ai/sdk/v2"

const CONTEXT_GROUP_TOOLS = new Set(["read", "glob", "grep", "list_dir"])

export function isContextGroupTool(part: Part): part is ToolPart {
  return part.type === "tool" && CONTEXT_GROUP_TOOLS.has(part.tool)
}
