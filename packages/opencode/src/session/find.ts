import { SessionV1 } from "@opencode-ai/core/v1/session"
import { createFindMatcher, findPartText } from "@opencode-ai/core/util/session-find-text"
import { Schema } from "effect"

// 会话内全文搜索：在服务端扫完整历史（不受前端分页影响），压缩前的消息也能搜到

export const Kind = Schema.Literals(["text", "reasoning", "tool", "file", "subtask", "summary"])
export type Kind = typeof Kind.Type

export const Hit = Schema.Struct({
  messageID: Schema.String,
  partID: Schema.String,
  // 所属轮次的用户消息，前端按它定位时间线行
  userMessageID: Schema.String,
  // 第几轮（从 1 开始，按用户消息计数）
  turn: Schema.Finite,
  role: Schema.Literals(["user", "assistant"]),
  kind: Kind,
  tool: Schema.optional(Schema.String),
  // 该命中是这个 part 内的第几处（从 0 开始），前端用它对齐 DOM 高亮
  ordinal: Schema.Finite,
  // 命中在 part 搜索文本里的位置与行号（从 1 开始），预览据此定位
  start: Schema.Finite,
  end: Schema.Finite,
  line: Schema.Finite,
  before: Schema.String,
  match: Schema.String,
  after: Schema.String,
  // 已被压缩出模型上下文
  compacted: Schema.Boolean,
  time: Schema.Finite,
}).annotate({ identifier: "SessionFindHit" })
export type Hit = typeof Hit.Type

export const Result = Schema.Struct({
  hits: Schema.Array(Hit),
  total: Schema.Finite,
  truncated: Schema.Boolean,
  // 正则写错时的报错，hits 为空
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "SessionFindResult" })
export type Result = typeof Result.Type

export const LIMIT = 2000
const BEFORE = 40
const AFTER = 80

export const partText = findPartText

// 单行片段：折叠空白，两端超长截断加省略号
function clip(text: string, max: number, side: "start" | "end") {
  const flat = text.replace(/\s+/g, " ")
  if (flat.length <= max) return flat
  return side === "start" ? "…" + flat.slice(flat.length - max).trimStart() : flat.slice(0, max).trimEnd() + "…"
}

export function find(input: {
  messages: readonly SessionV1.WithParts[]
  query: string
  caseSensitive?: boolean
  regex?: boolean
  word?: boolean
  limit?: number
}): Result {
  const matcher = createFindMatcher(input.query, input)
  if (!matcher) return { hits: [], total: 0, truncated: false }
  if ("error" in matcher) return { hits: [], total: 0, truncated: false, error: matcher.error }
  const limit = input.limit ?? LIMIT

  // 最近一次压缩之前（且不在保留尾部内）的消息都视为已压缩
  const lastCompaction = input.messages.findLastIndex(
    (message) => message.info.role === "user" && message.parts.some((part) => part.type === "compaction"),
  )
  const tailStart =
    lastCompaction >= 0
      ? input.messages[lastCompaction].parts.find(
          (part): part is SessionV1.CompactionPart => part.type === "compaction",
        )?.tail_start_id
      : undefined

  const hits: Hit[] = []
  let total = 0
  let turn = 0
  const turns = new Map<string, number>()
  input.messages.forEach((message, index) => {
    const info = message.info
    if (info.role === "user") turns.set(info.id, ++turn)
    const userMessageID = info.role === "assistant" ? info.parentID : info.id
    const summary = info.role === "assistant" && info.summary === true
    const compacted = index < lastCompaction && (tailStart === undefined || info.id < tailStart)
    for (const part of message.parts) {
      const source = partText(part)
      if (!source) continue
      const found = matcher.match(source.text)
      total += found.length
      let line = 1
      let lineFrom = 0
      found.forEach((range, ordinal) => {
        if (hits.length >= limit) return
        for (let at = source.text.indexOf("\n", lineFrom); at >= 0 && at < range.start; at = source.text.indexOf("\n", at + 1)) {
          line++
          lineFrom = at + 1
        }
        hits.push({
          messageID: info.id,
          partID: part.id,
          userMessageID,
          turn: turns.get(userMessageID) ?? turn,
          role: info.role,
          kind: summary && source.kind === "text" ? "summary" : source.kind,
          tool: source.tool,
          ordinal,
          start: range.start,
          end: range.end,
          line,
          before: clip(source.text.slice(Math.max(0, range.start - BEFORE * 2), range.start), BEFORE, "start"),
          match: source.text.slice(range.start, range.end).replace(/\s+/g, " "),
          after: clip(source.text.slice(range.end, range.end + AFTER * 2), AFTER, "end"),
          compacted,
          time: info.time.created,
        })
      })
    }
  })
  return { hits, total, truncated: total > hits.length }
}

export * as SessionFind from "./find"
