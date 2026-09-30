import { SessionV1 } from "@opencode-ai/core/v1/session"
import { PartID } from "./schema"
import type { Session } from "./session"

/**
 * 助手：挂在主会话下、与主会话共享上下文的侧边会话。
 * 每一轮都现场读取主会话的历史作为前缀（不复制、不分叉），前缀与主会话一致从而命中 provider 缓存；
 * 助手自己的对话只写入助手会话，完成后以「仅通知」的 synthetic 消息告知主会话。
 */

export const NOTICE_TAG = "assistant_notice"
/** 助手会话 metadata：最近一次压缩摘要覆盖到的主会话最后一条消息 ID */
export const CUTOFF = "assistant_cutoff"

export function isAssistant(session: Pick<Session.Info, "parentID" | "metadata">) {
  return session.parentID !== undefined && session.metadata?.assistant === true
}

const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "apply_patch"])

/** 从一批消息的编辑类工具调用中提取改动过的文件路径（按出现顺序去重）。 */
export function editedFiles(messages: SessionV1.WithParts[]) {
  const files: string[] = []
  const add = (file: unknown) => {
    if (typeof file === "string" && file && !files.includes(file)) files.push(file)
  }
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool" || !EDIT_TOOLS.has(part.tool)) continue
      if (part.state.status === "error") continue
      const input = part.state.input as Record<string, unknown> | undefined
      if (!input) continue
      add(input.filePath)
      if (Array.isArray(input.edits)) for (const edit of input.edits) add((edit as Record<string, unknown>)?.filePath)
      if (typeof input.patchText === "string") {
        for (const match of input.patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) add(match[1].trim())
      }
    }
  }
  return files
}

/**
 * 主会话历史的只读快照：去掉尚未完成的工具调用（否则会被当成「已中断」发给模型），
 * 保留已完成的步骤与已输出的文字。返回新对象，不修改原消息。
 */
export function sharedHistory(messages: SessionV1.WithParts[]) {
  return messages
    .map((message) => {
      if (message.info.role !== "assistant") return message
      const parts = message.parts.filter(
        (part) => !(part.type === "tool" && (part.state.status === "pending" || part.state.status === "running")),
      )
      return parts.length === message.parts.length ? message : { ...message, parts }
    })
    .filter((message) => message.parts.length > 0)
}

export function instruction(input: { mainBusy: boolean; mainFiles: string[]; compacted?: boolean }) {
  const lines = [
    `<assistant_mode>`,
    `You are now acting as a helper ("assistant") that the user called up alongside the main agent.`,
    `Everything above this point is the main session's transcript, shared with you read-only and live. It is context, not your task.`,
    ...(input.compacted
      ? [`The summary at the top covers the earlier part of both the main session and your own previous work with the user.`]
      : []),
    input.mainBusy
      ? `The main agent is still working in the same workspace right now. Do not continue, redo or undo its work.`
      : `The main agent is currently idle. Do not continue or redo its work unless the user asks.`,
    `Do only what the user asks below, then reply briefly with what you did.`,
  ]
  if (input.mainFiles.length > 0) {
    lines.push(
      `Files the main agent has recently edited (avoid changing them unless the user explicitly asks): ${input.mainFiles.slice(-20).join(", ")}`,
    )
  }
  lines.push(`</assistant_mode>`)
  return lines.join("\n")
}

function isSummary(message: SessionV1.WithParts) {
  return message.info.role === "assistant" && message.info.summary === true && !!message.info.finish && !message.info.error
}

/**
 * 助手看到的上下文：[助手自己的压缩摘要] + 主会话（摘要截止点之后）+ 助手的后续对话。
 * 没压缩过时就是「主会话全部 + 助手对话」，前缀与主会话一致。
 */
export function view(input: {
  main: SessionV1.WithParts[]
  own: SessionV1.WithParts[]
  cutoff?: string
  instruction?: (compacted: boolean) => string
}) {
  const index = input.own.findLastIndex(isSummary)
  const head = index >= 0 ? input.own.slice(0, index + 1) : []
  const rest = index >= 0 ? input.own.slice(index + 1) : input.own
  const cutoff = index >= 0 ? input.cutoff : undefined
  const shared = sharedHistory(input.main).filter((message) => !cutoff || message.info.id > cutoff)
  return [...head, ...shared, ...(input.instruction ? withInstruction(rest, input.instruction(index >= 0)) : rest)]
}

/** 压缩后摘要覆盖到主会话的哪一条：主会话仍在进行的最后一步不算进去，之后还能看到它的完整结果。 */
export function cutoffOf(input: { main: SessionV1.WithParts[]; busy: boolean; previous?: string }) {
  const list = sharedHistory(input.main).filter((message) => !input.previous || message.info.id > input.previous)
  const running = input.busy ? list.findLastIndex((message) => message.info.role === "assistant") : -1
  const covered = running >= 0 ? list.slice(0, running) : list
  return covered.at(-1)?.info.id ?? input.previous
}

/** 把助手说明作为 synthetic 文本放进助手会话第一条用户消息的开头（只进本轮请求，不落库）。 */
export function withInstruction(messages: SessionV1.WithParts[], text: string) {
  const index = messages.findIndex((message) => message.info.role === "user")
  if (index === -1) return messages
  const first = messages[index]
  const part: SessionV1.TextPart = {
    id: PartID.ascending(),
    messageID: first.info.id,
    sessionID: first.info.sessionID,
    type: "text",
    text,
    synthetic: true,
  }
  const next = [...messages]
  next[index] = { ...first, parts: [part, ...first.parts] }
  return next
}

function clip(text: string, limit: number) {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= limit ? flat : flat.slice(0, limit - 1) + "…"
}

/** 助手一轮结束后给主会话的通知条目。 */
export function noticeEntry(input: { request: string; reply: string; files: string[] }) {
  const lines = [`- Request: ${clip(input.request, 200)}`]
  if (input.files.length > 0) lines.push(`  Changed files: ${input.files.join(", ")}`)
  if (input.reply) lines.push(`  Result: ${clip(input.reply, 400)}`)
  return lines.join("\n")
}

export function noticeText(entries: string[]) {
  return [
    `<${NOTICE_TAG}>`,
    `FYI only — no reply needed. Continue your current task without stopping.`,
    `The user's assistant (a helper sharing this conversation) finished the following in the same workspace:`,
    ...entries,
    `If you later edit any of the changed files, read them again first.`,
    `</${NOTICE_TAG}>`,
  ].join("\n")
}

/** 从已有通知文本里取出条目，用于把多条尚未被主会话消费的通知合并成一条。 */
export function noticeEntries(text: string) {
  if (!text.startsWith(`<${NOTICE_TAG}>`)) return undefined
  const lines = text.split("\n")
  const start = lines.findIndex((line) => line.startsWith("- Request:"))
  const end = lines.findIndex((line) => line.startsWith("If you later edit"))
  if (start === -1 || end === -1) return []
  const entries: string[] = []
  for (const line of lines.slice(start, end)) {
    if (line.startsWith("- ")) entries.push(line)
    else if (entries.length > 0) entries[entries.length - 1] += "\n" + line
  }
  return entries
}

/** 只包含助手通知的 synthetic 用户消息：主会话无需为它单独回复。 */
export function isNoticeOnly(message: SessionV1.WithParts) {
  return (
    message.info.role === "user" &&
    message.parts.length > 0 &&
    message.parts.every((part) => part.type === "text" && part.synthetic && part.text.startsWith(`<${NOTICE_TAG}>`))
  )
}

export * as SessionAssistant from "./assistant"
