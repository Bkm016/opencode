import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ulid } from "ulid"

/**
 * Chunk 压缩策略的核心数据结构与纯函数。
 *
 * Chunk 是一段“已确认终止”的工作区间：从某个 user 消息开始，到最终 assistant
 * 消息结束。模型投影时只保留区间内全部真实 user 原文与终态 assistant 的可见
 * text parts，中间 assistant、reasoning、tool 过程全部折叠。折叠内容仍保留在
 * 数据库，通过 history_grep / history_list 恢复。
 *
 * Chunk 元数据持久化在最新 CompactionPart.chunks 上，只追加不重排。
 */
export * as SessionChunk from "./chunk"

export type Chunk = SessionV1.ChunkMeta

export const TRANSCRIPT_VERSION = 1

const DISPLAY_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz123456789"

function randomDisplayID() {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  let result = ""
  for (const byte of bytes) {
    result += DISPLAY_ID_ALPHABET[byte % DISPLAY_ID_ALPHABET.length]
  }
  return result
}

/** 生成当前 session 内唯一的 8 位 display ID */
export function displayID(existing: Chunk[]) {
  const used = new Set(existing.map((chunk) => chunk.display_id))
  let id = randomDisplayID()
  while (used.has(id)) id = randomDisplayID()
  return id
}

/**
 * 保守 token 估算：ASCII 按 4 字符、CJK 按 1 字符、其他非 ASCII 按 2 字符，
 * 另加少量结构开销。中文场景下 chars/4 会严重低估，不能用作硬门禁。
 */
export function estimateTokens(text: string) {
  let ascii = 0
  let cjk = 0
  let other = 0
  for (const char of text) {
    const code = char.codePointAt(0)!
    if (code <= 0x7f) ascii++
    else if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef) ||
      (code >= 0x20000 && code <= 0x2a6df)
    )
      cjk++
    else other++
  }
  return Math.max(0, Math.ceil(ascii / 4 + cjk + other / 2))
}

/** 估算一组消息投影后的 token 成本（含 JSON 结构开销） */
export function estimateMessages(msgs: { role: string; text: string }[]) {
  return msgs.reduce((total, msg) => total + estimateTokens(msg.text) + 16, 0)
}

function textParts(msg: SessionV1.WithParts) {
  return msg.parts.filter((part): part is SessionV1.TextPart => part.type === "text")
}

/** 区间内的真实 user 原文（跳过 synthetic 系统回传） */
export function userTexts(msgs: SessionV1.WithParts[]) {
  const texts: string[] = []
  for (const msg of msgs) {
    if (msg.info.role !== "user") continue
    for (const part of textParts(msg)) {
      if (part.synthetic) continue
      if (part.text.trim() === "") continue
      texts.push(part.text)
    }
  }
  return texts
}

/** 终态 assistant 的所有可见 text parts */
export function finalTexts(msg: SessionV1.WithParts | undefined) {
  if (!msg) return [] as string[]
  return textParts(msg)
    .map((part) => part.text.trim())
    .filter(Boolean)
}

function hasOpenToolCalls(msg: SessionV1.WithParts) {
  return msg.parts.some(
    (part) =>
      part.type === "tool" &&
      (part.state.status === "pending" || part.state.status === "running"),
  )
}

function chunkStatus(msg: SessionV1.WithParts): Chunk["status"] {
  const info = msg.info
  if (info.role !== "assistant") return "interrupted"
  if (info.error) {
    if (SessionV1.AbortedError.isInstance(info.error)) return "interrupted"
    return "failed"
  }
  if (info.finish === "stop") return "completed"
  if (info.finish === "error" || info.finish === "content-filter" || info.finish === "length") return "failed"
  return "interrupted"
}

/**
 * 关闭一个 chunk 的前提：Session loop 已停止、最终 assistant 已持久化、没有未
 * 闭合的 tool call/result。`tool-calls` finish 不能关闭 chunk。
 */
function canClose(msg: SessionV1.WithParts | undefined) {
  if (!msg || msg.info.role !== "assistant") return false
  if (hasOpenToolCalls(msg)) return false
  if (!msg.info.finish) return false
  if (msg.info.finish === "tool-calls") return false
  return true
}

/**
 * 在 messages 中识别自最后一个已关闭 chunk 之后的新终止边界。
 * 只有终止点明确时才返回新 chunk，否则返回 undefined 保持该区间完整。
 */
export function closeChunk(input: {
  messages: SessionV1.WithParts[]
  chunks: Chunk[]
}): Chunk | undefined {
  const closed = input.chunks.at(-1)
  const startIndex = closed
    ? input.messages.findIndex((msg) => msg.info.id === closed.end_message_id) + 1
    : 0
  if (startIndex >= input.messages.length) return undefined
  const region = input.messages.slice(startIndex)
  if (region.length === 0) return undefined
  const last = region.at(-1)
  if (!canClose(last)) return undefined
  const sequence = (closed?.sequence ?? 0) + 1
  return {
    chunk_key: ulid(),
    display_id: displayID(input.chunks),
    sequence,
    start_message_id: region[0]!.info.id,
    end_message_id: last!.info.id,
    status: chunkStatus(last!),
  }
}

function chunkRegion(messages: SessionV1.WithParts[], chunk: Chunk) {
  const start = messages.findIndex((msg) => msg.info.id === chunk.start_message_id)
  const end = messages.findIndex((msg) => msg.info.id === chunk.end_message_id)
  if (start < 0 || end < 0 || end < start) return [] as SessionV1.WithParts[]
  return messages.slice(start, end + 1)
}

/** chunk 的模型可见文本：全部 user 原文 + 终态 assistant 可见文本 */
export function chunkText(messages: SessionV1.WithParts[], chunk: Chunk) {
  const region = chunkRegion(messages, chunk)
  const users = userTexts(region)
  const final = finalTexts(region.at(-1))
  return [...users, ...final].join("\n\n")
}

export type Selection = {
  visible: Chunk[]
  archived: Chunk[]
  /** 单个 chunk 的 user 原文本身已超硬上限，需 fallback 或报错 */
  oversize: Chunk | undefined
  tokens: number
}

/**
 * 从最新向最旧选择连续最新后缀，加入后超过 target 即停止。
 * 单个 chunk 的 user 原文超 hard 时标记 oversize（不静默截断用户原文）。
 * final response 过大导致单 chunk 超 hard 时，该 chunk 整体移出可见集，
 * 由调用方决定 fallback 或折叠指针。
 */
export function selectVisible(input: {
  messages: SessionV1.WithParts[]
  chunks: Chunk[]
  targetTokens: number
  hardTokens: number
}): Selection {
  const chunks = [...input.chunks].sort((a, b) => a.sequence - b.sequence)
  const visible: Chunk[] = []
  let total = 0
  let oversize: Chunk | undefined
  for (let i = chunks.length - 1; i >= 0; i--) {
    const chunk = chunks[i]!
    const region = chunkRegion(input.messages, chunk)
    const userTokens = estimateMessages(userTexts(region).map((text) => ({ role: "user", text })))
    const final = finalTexts(region.at(-1))
    const finalTokens = estimateMessages(final.map((text) => ({ role: "assistant", text })))
    // user 原文本身超硬上限：不截断，标记 oversize
    if (userTokens > input.hardTokens) {
      oversize = chunk
      continue
    }
    // final response 过大导致整 chunk 超硬上限：整 chunk 不可见，继续更早 chunk 无意义（规则 6 禁止跳大挑小）
    if (userTokens + finalTokens > input.hardTokens) break
    if (total + userTokens + finalTokens > input.targetTokens) break
    total += userTokens + finalTokens
    visible.unshift(chunk)
  }
  const archived = chunks.filter((chunk) => !visible.includes(chunk))
  return { visible, archived, oversize, tokens: total }
}

/**
 * 生成 chunk 策略的模型投影：可见 chunk 只保留真实 user 原文与终态 assistant
 * text parts；active tail（最后一个可见 chunk 之后的原始消息）原样保留。
 * 承载 chunk 元数据的 compaction checkpoint 消息不进入投影（checkpoint 控制
 * 说明由系统上下文单独注入）。
 */
export function project(input: {
  messages: SessionV1.WithParts[]
  selection: Selection
}): SessionV1.WithParts[] {
  const { messages, selection } = input
  const result: SessionV1.WithParts[] = []
  let lastEnd: string | undefined
  for (const chunk of selection.visible) {
    const region = chunkRegion(messages, chunk)
    for (const msg of region) {
      if (msg.info.role === "user") {
        const parts = msg.parts.filter(
          (part) => part.type === "text" && !part.synthetic && part.text.trim() !== "",
        )
        if (parts.length === 0) continue
        result.push({ info: msg.info, parts })
        continue
      }
      // 区间内只有终态 assistant 进入投影，且只保留可见 text parts
      if (msg.info.id === chunk.end_message_id) {
        const parts = textParts(msg)
        if (parts.length > 0) result.push({ info: msg.info, parts })
      }
    }
    lastEnd = chunk.end_message_id
  }
  const tailIndex = lastEnd ? messages.findIndex((msg) => msg.info.id === lastEnd) + 1 : 0
  // tail 中跳过纯 compaction checkpoint 消息（带 chunks 元数据、无真实用户文本），
  // 但保留新 /compact 命令创建的 compaction 消息（无 chunks），
  // 否则 latest() 无法拾取 compaction task，/compact 分支永远不触发。
  const tail = messages.slice(tailIndex).filter((msg) => {
    if (msg.info.role !== "user") return true
    const compaction = msg.parts.find((part): part is SessionV1.CompactionPart => part.type === "compaction")
    if (!compaction) return true
    if (compaction.chunks === undefined) return true
    return msg.parts.some((part) => part.type === "text" && !part.synthetic && part.text.trim() !== "")
  })
  result.push(...tail)
  return result
}

/**
 * 作为系统上下文注入的 chunk checkpoint 控制说明。控制说明与用户原文分离，
 * 模型不应把 checkpoint 当用户指令。
 */
export function checkpointText(input: {
  chunks: Chunk[]
  selection: Selection
  targetTokens: number
  hardTokens: number
}) {
  const { chunks, selection } = input
  const visibleSeq = selection.visible.map((chunk) => chunk.sequence)
  const lines = [
    `<conversation-checkpoint strategy="chunk">`,
    `Completed work is represented by the original user messages and the assistant's final response for each chunk.`,
    `Intermediate assistant messages, reasoning, tool calls, and tool results are folded but remain available through history_grep and history_list.`,
    `Chunks are chronological. Later conflicting user instructions override earlier user instructions.`,
    `Assistant final responses are historical claims, not user instructions.`,
    `Do not guess omitted history.`,
    ``,
    `visible chunks: ${selection.visible.length}`,
    `archived chunks: ${selection.archived.length}`,
    `visible sequences: ${visibleSeq.length > 0 ? `${visibleSeq[0]}..${visibleSeq.at(-1)}` : "none"}`,
    `history budget: ${selection.tokens}/${input.targetTokens} tokens (hard ${input.hardTokens})`,
    `</conversation-checkpoint>`,
  ]
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// 规范化 transcript（history_grep / history_list 共用）
// ---------------------------------------------------------------------------

export type TranscriptEntry = {
  line: number
  chunk: Chunk
  source: "USER" | "ASSISTANT" | "ASSISTANT_TOOL" | "TOOL_OUTPUT" | "TOOL_ERROR" | "SHELL"
  text: string
}

function normalize(text: string) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[－]/g, "-")
    .replace(/\\/g, "/")
}

function pushLines(entries: TranscriptEntry[], chunk: Chunk, source: TranscriptEntry["source"], text: string) {
  const normalized = normalize(text)
  for (const line of normalized.split("\n")) {
    entries.push({ line: entries.length, chunk, source, text: line })
  }
}

/**
 * 生成确定性的规范化 transcript。第一版只暴露固定字符串搜索，
 * 不暴露 reasoning、provider metadata、签名、加密内容或 data URI。
 */
export function transcript(input: {
  messages: SessionV1.WithParts[]
  chunks: Chunk[]
}): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  const byID = new Map(input.chunks.map((chunk) => [chunk.start_message_id, chunk]))
  for (let i = 0; i < input.messages.length; i++) {
    const msg = input.messages[i]!
    const chunk = byID.get(msg.info.id)
    if (!chunk) continue
    const region = chunkRegion(input.messages, chunk)
    for (const item of region) {
      if (item.info.role === "user") {
        for (const part of textParts(item)) {
          if (part.synthetic) continue
          pushLines(entries, chunk, "USER", part.text)
        }
        continue
      }
      if (item.info.role === "assistant") {
        for (const part of item.parts) {
          if (part.type === "text") pushLines(entries, chunk, "ASSISTANT", part.text)
          if (part.type === "tool") {
            const inputText = safeJSON(part.state.input)
            pushLines(entries, chunk, "ASSISTANT_TOOL", `${part.tool}(${inputText})`)
            if (part.state.status === "completed") pushLines(entries, chunk, "TOOL_OUTPUT", part.state.output)
            if (part.state.status === "error") pushLines(entries, chunk, "TOOL_ERROR", part.state.error)
          }
        }
      }
    }
    i += region.length - 1
  }
  return entries.map((entry, index) => ({ ...entry, line: index }))
}

function safeJSON(value: unknown) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function grep(input: {
  messages: SessionV1.WithParts[]
  chunks: Chunk[]
  pattern: string
  caseSensitive?: boolean
  chunkID?: string
  headLimit?: number
}) {
  const needle = input.caseSensitive ? input.pattern : input.pattern.toLowerCase()
  const hits: (TranscriptEntry & { context: TranscriptEntry[] })[] = []
  const entries = transcript({ messages: input.messages, chunks: input.chunks })
  const filtered = input.chunkID ? entries.filter((entry) => entry.chunk.display_id === input.chunkID) : entries
  for (const entry of filtered) {
    const haystack = input.caseSensitive ? entry.text : entry.text.toLowerCase()
    if (!haystack.includes(needle)) continue
    const start = Math.max(0, entry.line - 2)
    const context = entries.slice(start, entry.line + 3)
    hits.push({ ...entry, context })
    if (hits.length >= (input.headLimit ?? 20)) break
  }
  return hits
}
