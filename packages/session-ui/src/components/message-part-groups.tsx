import type { Part, ToolPart } from "@opencode-ai/sdk/v2"

const CONTEXT_GROUP_TOOLS = new Set(["read", "glob", "grep", "list_dir"])

/** 可折叠工具组共享的展示参数；open 为空时由组内本地状态控制。 */
export interface GroupToolRefs {
  busy?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onSizeChange?: () => void
}

export function isContextGroupTool(part: Part): part is ToolPart {
  return part.type === "tool" && CONTEXT_GROUP_TOOLS.has(part.tool)
}

export function isComputerUseGroupTool(part: Part): part is ToolPart {
  return part.type === "tool" && part.tool === "computer_use"
}
