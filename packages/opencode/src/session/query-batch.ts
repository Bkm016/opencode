import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { ShellID } from "@/tool/shell/id"

// 连续 N 步都只发一次只读查询时提醒合并；按 N 的倍数触发，避免每步重复提醒。
export const QUERY_BATCH_STREAK = 3

const READ_TOOLS = new Set(["read", "grep", "glob", "list_dir"])
const READ_COMMANDS = new Set(["cat", "head", "tail", "ls", "find", "grep", "rg", "wc", "file", "tree", "stat", "sed", "awk"])
const GIT_READ = new Set(["log", "show", "diff", "status", "grep", "blame", "ls-files"])

// 只认明显只读的 shell 命令：每段管道/串联的首个词都在白名单内，且没有写重定向或原地修改。
export function isReadOnlyCommand(command: string) {
  // 引号内的 `|`、`>` 属于参数（如 grep "a\|b"），先抹掉再按运算符切分。
  const text = command
    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''")
    .replace(/\d?>&\d|\d?>\s*\/dev\/null/g, "")
  if (/>|\btee\b|\bsed\s+(-\w*\s+)*-i|\bawk\s+.*-i\s+inplace/.test(text)) return false
  const segments = text
    .split(/&&|\|\||;|\|/)
    .map((segment) => segment.trim())
    .filter(Boolean)
  if (segments.length === 0) return false
  return segments.every((segment) => {
    const words = segment.replace(/^cd\s+\S+\s*$/, "cd").split(/\s+/)
    const head = words[0]
    if (head === "cd") return true
    if (head === "git") return GIT_READ.has(words.find((word, i) => i > 0 && !word.startsWith("-")) ?? "")
    return READ_COMMANDS.has(head)
  })
}

function isReadOnlyQuery(part: SessionV1.Part) {
  if (part.type !== "tool") return false
  if (READ_TOOLS.has(part.tool)) return true
  if (part.tool !== ShellID.ToolID) return false
  const input = part.state.input as { command?: unknown; background?: unknown } | string
  if (typeof input !== "object" || input.background === true) return false
  return typeof input.command === "string" && isReadOnlyCommand(input.command)
}

// 从最新一步往回数：每步恰好一次工具调用且为只读查询，遇到用户消息或其他步即停止。
export function singleQueryStreak(messages: SessionV1.WithParts[]) {
  let streak = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.info.role !== "assistant") break
    const tools = message.parts.filter((part) => part.type === "tool")
    if (tools.length !== 1 || !isReadOnlyQuery(tools[0])) break
    streak++
  }
  return streak
}

export function shouldRemind(messages: SessionV1.WithParts[]) {
  const streak = singleQueryStreak(messages)
  return streak >= QUERY_BATCH_STREAK && streak % QUERY_BATCH_STREAK === 0
}

export * as QueryBatch from "./query-batch"
