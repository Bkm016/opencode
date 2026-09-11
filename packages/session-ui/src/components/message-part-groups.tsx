import type { JSX } from "solid-js"
import type { Part, ToolPart } from "@opencode-ai/sdk/v2"

/** 可折叠工具组共享的展示参数；open 为空时由组内本地状态控制。 */
export interface GroupToolRefs {
  busy?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onSizeChange?: () => void
}

export type PartRef = {
  messageID: string
  partID: string
}

export type ToolGroupID = "context" | "computerUse" | "python" | "bash" | "history" | "web"

export type PartGroup =
  | {
      key: string
      type: "part"
      ref: PartRef
    }
  | {
      key: string
      type: ToolGroupID
      refs: PartRef[]
    }

export interface ToolGroupItemProps {
  part: ToolPart
  index: number
  parts: ToolPart[]
  i18n: any
  message?: any
  showAssistantCopyPartID?: string | null
  turnDurationMs?: number
  shellToolDefaultOpen?: boolean
  editToolDefaultOpen?: boolean
  onCompactHere?: (messageID: string) => void
}

export interface ToolGroupDefinition {
  /** 组唯一标识，例如 "context" | "computerUse" | "python" */
  id: ToolGroupID
  /** 判断该 ToolPart 是否属于此组 */
  match: (part: ToolPart) => boolean
  /** 折叠标题状态文本 */
  title: {
    active: (i18n: any) => string
    done: (i18n: any) => string
  }
  /** 折叠栏摘要渲染 */
  renderSummary: (props: { parts: ToolPart[]; i18n: any }) => JSX.Element
  /** 展开列表条目的自定义渲染；如果不提供，默认使用通用的 Part 组件 */
  renderItem?: (props: ToolGroupItemProps) => JSX.Element
  /** CSS data-component 前缀名，默认使用 `${id}-group` */
  componentName?: string
}

class ToolGroupRegistryImpl {
  private readonly groups: ToolGroupDefinition[] = []

  register(definition: ToolGroupDefinition) {
    const existing = this.groups.findIndex((g) => g.id === definition.id)
    if (existing >= 0) {
      this.groups[existing] = definition
    } else {
      this.groups.push(definition)
    }
  }

  find(part: ToolPart): ToolGroupDefinition | undefined {
    return this.groups.find((g) => g.match(part))
  }

  get(id: string): ToolGroupDefinition | undefined {
    return this.groups.find((g) => g.id === id)
  }

  all(): readonly ToolGroupDefinition[] {
    return this.groups
  }
}

/** 连续工具聚合注册表 */
export const ToolGroupRegistry = new ToolGroupRegistryImpl()

/** 累加计算工具组内所有已完成部件的实际执行耗时总和 */
export function computeToolGroupDuration(parts: ToolPart[]): string | undefined {
  let totalMs = 0
  let validCount = 0
  for (const part of parts) {
    const time = part.state && "time" in part.state ? (part.state as any).time : undefined
    if (time && typeof time.start === "number" && typeof time.end === "number") {
      totalMs += Math.max(0, time.end - time.start)
      validCount++
    }
  }
  if (validCount === 0 || totalMs <= 0) return undefined
  if (totalMs < 1000) return `${totalMs}ms`
  if (totalMs < 60000) return `${(totalMs / 1000).toFixed(totalMs < 10000 ? 2 : 1)}s`
  const mins = Math.floor(totalMs / 60000)
  const secs = Math.round((totalMs % 60000) / 1000)
  return `${mins}m ${secs}s`
}

function sameRef(a: PartRef, b: PartRef) {
  return a.messageID === b.messageID && a.partID === b.partID
}

function sameGroup(a: PartGroup, b: PartGroup) {
  if (a === b) return true
  if (a.key !== b.key) return false
  if (a.type !== b.type) return false
  if (a.type === "part") {
    if (b.type !== "part") return false
    return sameRef(a.ref, b.ref)
  }
  if (b.type === "part") return false
  if (a.refs.length !== b.refs.length) return false
  return a.refs.every((ref, i) => sameRef(ref, b.refs[i]!))
}

export function sameGroups(a: readonly PartGroup[] | undefined, b: readonly PartGroup[] | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((item, i) => sameGroup(item, b[i]!))
}

/**
 * 通用连续工具聚合算法
 * 线性扫描部件流，命中注册分组时聚合成 group，其余保持为单独的 part
 */
export function groupParts(parts: { messageID: string; part: Part }[]): PartGroup[] {
  const result: PartGroup[] = []
  let currentGroup: { id: ToolGroupID; start: number } | undefined

  const flushGroup = (end: number) => {
    if (!currentGroup) return
    const first = parts[currentGroup.start]
    if (first) {
      result.push({
        key: `${currentGroup.id}:${first.part.id}`,
        type: currentGroup.id,
        refs: parts.slice(currentGroup.start, end + 1).map((item) => ({
          messageID: item.messageID,
          partID: item.part.id,
        })),
      })
    }
    currentGroup = undefined
  }

  parts.forEach((item, index) => {
    const matched = item.part.type === "tool" ? ToolGroupRegistry.find(item.part as ToolPart) : undefined

    if (matched) {
      if (currentGroup?.id === matched.id) {
        return
      }
      flushGroup(index - 1)
      currentGroup = { id: matched.id, start: index }
      return
    }

    flushGroup(index - 1)
    result.push({
      key: `part:${item.messageID}:${item.part.id}`,
      type: "part",
      ref: {
        messageID: item.messageID,
        partID: item.part.id,
      },
    })
  })

  flushGroup(parts.length - 1)
  return result
}

/** 兼容保留旧版判断函数 */
const CONTEXT_GROUP_TOOLS = new Set(["read", "glob", "grep", "list_dir"])
export function isContextGroupTool(part: Part): part is ToolPart {
  return part.type === "tool" && CONTEXT_GROUP_TOOLS.has(part.tool)
}

export function isComputerUseGroupTool(part: Part): part is ToolPart {
  return part.type === "tool" && part.tool === "computer_use"
}

export function isPythonGroupTool(part: Part): part is ToolPart {
  return part.type === "tool" && part.tool === "python"
}

export function isBashGroupTool(part: Part): part is ToolPart {
  return part.type === "tool" && part.tool === "bash"
}

const HISTORY_GROUP_TOOLS = new Set(["history_grep", "history_list"])
export function isHistoryGroupTool(part: Part): part is ToolPart {
  return part.type === "tool" && HISTORY_GROUP_TOOLS.has(part.tool)
}

const WEB_GROUP_TOOLS = new Set(["webfetch", "websearch"])
export function isWebGroupTool(part: Part): part is ToolPart {
  return part.type === "tool" && WEB_GROUP_TOOLS.has(part.tool)
}
