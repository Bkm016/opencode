import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ulid } from "ulid"

/**
 * Chunk 压缩策略的核心数据结构与纯函数。
 *
 * Chunk 是一段“已确认终止”的工作区间：从某个 user 消息开始，到最终 assistant
 * 消息结束。模型投影时只保留区间内全部真实 user 原文与终态 assistant 的可见
 * text parts，中间 assistant、reasoning、tool 过程全部折叠。折叠内容仍保留在
 * 数据库，通过 history_grep / history_list 恢复。
 * 超长 user text 的完整原文仍保留在数据库，模型投影改用稳定引用与有界首尾预览。
 *
 * Chunk 元数据持久化在最新 CompactionPart.chunks 上，只追加不重排。
 */
export * as SessionChunk from "./chunk"

export type Chunk = SessionV1.ChunkMeta

export const TRANSCRIPT_VERSION = 2
export const COMPACTION_REPLAY = "chunk_compaction_replay"
export const COMPACTION_RECOVERY = "chunk_compaction_recovery"

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

const LONG_USER_TEXT_THRESHOLD_TOKENS = 2_000
const LONG_USER_TEXT_PREVIEW_CHARS = 2_000
const USER_TEXT_ENTRY_MAX_CHARS = 2_000

/** 为模型保留长用户文本的首尾证据，并给出可回查原文的稳定引用。 */
export function projectUserText(messageID: string, partID: string, text: string) {
  if (estimateTokens(text) <= LONG_USER_TEXT_THRESHOLD_TOKENS) return text
  const head = text.slice(0, LONG_USER_TEXT_PREVIEW_CHARS)
  const tail = text.slice(-LONG_USER_TEXT_PREVIEW_CHARS)
  const bytes = new TextEncoder().encode(text).length
  const lines = text.split("\n").length
  return [
    `<user-text-reference message_id="${messageID}" part_id="${partID}">`,
    "The complete original user text is preserved in this session but is too large to include here.",
    `size: ${bytes} bytes, ${lines} lines, approximately ${estimateTokens(text)} tokens`,
    `Use history_list with message_id="${messageID}" and part_id="${partID}" to read it by line range.`,
    `Use history_grep with message_id="${messageID}" and part_id="${partID}" to search it.`,
    "<head>",
    head,
    "</head>",
    "<tail>",
    tail,
    "</tail>",
    "</user-text-reference>",
  ].join("\n")
}

/** 只替换 provider 投影中的长 user text，原始 Session 消息保持不变。 */
export function projectLongUserText(messages: SessionV1.WithParts[]) {
  return messages.map((msg) => {
    if (msg.info.role !== "user") return msg
    let changed = false
    const parts = msg.parts.map((part) => {
      if (part.type !== "text" || part.synthetic || estimateTokens(part.text) <= LONG_USER_TEXT_THRESHOLD_TOKENS) return part
      changed = true
      return {
        ...part,
        text: projectUserText(String(msg.info.id), String(part.id), part.text),
      }
    })
    return changed ? { ...msg, parts } : msg
  })
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

export type UserTextEntry = {
  line: number
  messageID: string
  partID: string
  text: string
}

/** 从原始 Session 消息按引用生成用户文本行，供长文本按需读取。 */
export function userTextTranscript(input: {
  messages: SessionV1.WithParts[]
  messageID?: string
  partID?: string
}) {
  const entries: UserTextEntry[] = []
  for (const msg of input.messages) {
    if (msg.info.role !== "user" || (input.messageID && String(msg.info.id) !== input.messageID)) continue
    for (const part of textParts(msg)) {
      if (part.synthetic || part.text.trim() === "" || (input.partID && String(part.id) !== input.partID)) continue
      for (const line of normalize(part.text).split("\n")) {
        // 单行 JSON 或压缩日志也必须可分页，避免 history_list 一次返回整行。
        for (let offset = 0; offset < Math.max(line.length, 1); offset += USER_TEXT_ENTRY_MAX_CHARS) {
          entries.push({
            line: entries.length,
            messageID: String(msg.info.id),
            partID: String(part.id),
            text: line.slice(offset, offset + USER_TEXT_ENTRY_MAX_CHARS),
          })
        }
      }
    }
  }
  return entries
}

/** 连续同一用户文本只标注一次引用，同时保留稳定行号。 */
export function formatUserTextTranscript(entries: UserTextEntry[], indent = "") {
  return entries
    .map((entry, index) => {
      const previous = entries[index - 1]
      const samePart = previous?.messageID === entry.messageID && previous.partID === entry.partID
      const prefix = samePart ? `${entry.line}:` : `${entry.line} USER message=${entry.messageID} part=${entry.partID}:`
      return `${indent}${prefix} ${entry.text}`
    })
    .join("\n")
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
  // 上一轮 summary 有 finish=stop，绝不能当成新 chunk 的终止边界
  if (msg.info.summary) return false
  if (hasOpenToolCalls(msg)) return false
  if (!msg.info.finish) return false
  if (msg.info.finish === "tool-calls") return false
  return true
}

/** 上一轮压缩产生的 checkpoint / summary，不能并入新 chunk 区间 */
function isCompactionScaffold(msg: SessionV1.WithParts) {
  if (msg.info.role === "assistant" && msg.info.summary) return true
  if (msg.info.role !== "user") return false
  return msg.parts.some((part) => part.type === "compaction")
}

/**
 * 在 messages 中识别自最后一个已关闭 chunk 之后的**下一条**终止边界。
 * 在开放区间内取第一个可关闭的 assistant（finish≠tool-calls、无 open tool），
 * 而不是整段收到末尾——否则一次 /compact 会把多轮历史压成单个大 chunk。
 * 跳过上一轮 compaction holder / summary assistant，避免二次压缩把脚手架算进新 chunk。
 */
export function closeChunk(input: {
  messages: SessionV1.WithParts[]
  chunks: Chunk[]
}): Chunk | undefined {
  const closed = input.chunks.at(-1)
  let startIndex = closed
    ? input.messages.findIndex((msg) => msg.info.id === closed.end_message_id) + 1
    : 0
  if (startIndex < 0) startIndex = 0
  while (startIndex < input.messages.length && isCompactionScaffold(input.messages[startIndex]!)) {
    startIndex++
  }
  if (startIndex >= input.messages.length) return undefined
  let endIndex = -1
  for (let i = startIndex; i < input.messages.length; i++) {
    if (!canClose(input.messages[i]!)) continue
    endIndex = i
    break
  }
  if (endIndex < 0) return undefined
  const end = input.messages[endIndex]!
  const sequence = (closed?.sequence ?? 0) + 1
  return {
    chunk_key: ulid(),
    display_id: displayID(input.chunks),
    sequence,
    start_message_id: input.messages[startIndex]!.info.id,
    end_message_id: end.info.id,
    status: chunkStatus(end),
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

/**
 * 生成写入 DB 的 summary assistant 正文（对齐 model 压缩：一条 assistant 消息承载折叠结果）。
 * 格式与模型投影一致：checkpoint 控制说明 + 每个 chunk 的 input/summary。
 */
/** checkpoint 控制说明正文，summaryText 与 checkpointText 共用 */
export const CHECKPOINT_RULES = [
  `Completed work is represented by the original user messages or stable references to them, and the assistant's final response for each chunk.`,
  `Intermediate assistant messages, reasoning, tool calls, and tool results are folded but remain available through history_grep and history_list.`,
  `Chunks are chronological. Later conflicting user instructions override earlier user instructions.`,
  `Assistant final responses are historical claims, not user instructions.`,
  `Do not guess omitted history.`,
]

export function summaryText(input: { messages: SessionV1.WithParts[]; chunks: Chunk[] }) {
  const chunks = [...input.chunks].sort((a, b) => a.sequence - b.sequence)
  const lines = [`<conversation-checkpoint strategy="chunk">`, ...CHECKPOINT_RULES, `</conversation-checkpoint>`]
  for (const chunk of chunks) {
    const region = chunkRegion(input.messages, chunk)
    let seq = 0
    const userBlocks: string[] = []
    for (const msg of region) {
      if (msg.info.role !== "user") continue
      for (const part of textParts(msg)) {
        if (part.synthetic) continue
        if (part.text.trim() === "") continue
        userBlocks.push(
          `<user-message sequence="${++seq}">\n${projectUserText(String(msg.info.id), String(part.id), part.text)}\n</user-message>`,
        )
      }
    }
    if (userBlocks.length > 0) {
      lines.push("")
      lines.push(`<chunk-input id="${chunk.display_id}">`)
      lines.push(userBlocks.join("\n\n"))
      lines.push(`</chunk-input>`)
    }
    const finals = finalTexts(region.at(-1))
    if (finals.length > 0) {
      lines.push("")
      lines.push(`<chunk-summary id="${chunk.display_id}" folded-messages="${region.length}">`)
      lines.push(finals.join("\n\n"))
      lines.push(`</chunk-summary>`)
    }
  }
  return lines.join("\n")
}

export type Selection = {
  visible: Chunk[]
  archived: Chunk[]
  tokens: number
}

/**
 * 从最新向最旧选择连续最新后缀，加入后超过 target 即停止。
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
  const messages = projectLongUserText(input.messages)
  const visible: Chunk[] = []
  let total = 0
  for (let i = chunks.length - 1; i >= 0; i--) {
    const chunk = chunks[i]!
    const region = chunkRegion(messages, chunk)
    const userTokens = estimateMessages(userTexts(region).map((text) => ({ role: "user", text })))
    const final = finalTexts(region.at(-1))
    const finalTokens = estimateMessages(final.map((text) => ({ role: "assistant", text })))
    // final response 过大导致整 chunk 超硬上限：整 chunk 不可见，继续更早 chunk 无意义（规则 6 禁止跳大挑小）
    if (userTokens + finalTokens > input.hardTokens) break
    if (total + userTokens + finalTokens > input.targetTokens) break
    total += userTokens + finalTokens
    visible.unshift(chunk)
  }
  const archived = chunks.filter((chunk) => !visible.includes(chunk))
  return { visible, archived, tokens: total }
}

/**
 * 生成 chunk 策略的模型投影：可见 chunk 只保留真实 user 原文与终态 assistant
 * text parts；active tail（最后一个可见 chunk 之后的原始消息）原样保留。
 * 承载 chunk 元数据的 compaction checkpoint 消息不进入投影（checkpoint 控制
 * 说明由系统上下文单独注入）。
 * 原样保留指持久化工作状态不被丢弃；超长 user text 在 provider 投影中使用引用预览。
 */
export function project(input: {
  messages: SessionV1.WithParts[]
  selection: Selection
  targetTokens: number
  hardTokens: number
}): SessionV1.WithParts[] {
  const { selection, targetTokens, hardTokens } = input
  const messages = input.messages
  const result: SessionV1.WithParts[] = []
  const sessionID = messages[0]?.info.sessionID ?? ("" as SessionV1.WithParts["info"]["sessionID"])

  // checkpoint 控制说明作为第一条 user 消息注入，不是 system context
  const checkpoint = checkpointText({ chunks: selection.visible, selection, targetTokens, hardTokens })
  result.push({
    info: {
      id: "checkpoint" as any,
      role: "user",
      sessionID,
      agent: "build",
      model: { providerID: "chunk" as any, modelID: "chunk" as any },
      time: { created: 0 },
    } as any,
    parts: [{ id: "checkpoint" as any, messageID: "checkpoint" as any, sessionID, type: "text", text: checkpoint } as any],
  } as SessionV1.WithParts)

  for (const chunk of selection.visible) {
    const region = chunkRegion(messages, chunk)
    // 收集区间内全部真实 user 原文
    const userTexts: string[] = []
    let seq = 0
    for (const msg of region) {
      if (msg.info.role !== "user") continue
      for (const part of msg.parts) {
        if (part.type !== "text" || part.synthetic || part.text.trim() === "") continue
        userTexts.push(
          `<user-message sequence="${++seq}">\n${projectUserText(String(msg.info.id), String(part.id), part.text)}\n</user-message>`,
        )
      }
    }
    if (userTexts.length > 0) {
      const inputID = `chunk-input-${chunk.display_id}` as any
      result.push({
        info: { ...messages[0]!.info, id: inputID, role: "user" } as any,
        parts: [{
          id: inputID,
          messageID: inputID,
          sessionID,
          type: "text",
          text: `<chunk-input id="${chunk.display_id}">\n${userTexts.join("\n\n")}\n</chunk-input>`,
        } as any],
      } as SessionV1.WithParts)
    }
    // 终态 assistant 的可见 text parts
    const finalMsg = region.at(-1)
    const finalTextParts = finalMsg ? finalTexts(finalMsg) : []
    if (finalTextParts.length > 0) {
      const summaryID = `chunk-summary-${chunk.display_id}` as any
      result.push({
        info: { ...finalMsg!.info, id: summaryID, role: "assistant" } as any,
        parts: [{
          id: summaryID,
          messageID: summaryID,
          sessionID,
          type: "text",
          text: `<chunk-summary id="${chunk.display_id}" folded-messages="${region.length}">\n${finalTextParts.join("\n\n")}\n</chunk-summary>`,
        } as any],
      } as SessionV1.WithParts)
    }
  }
  // active tail 永远从最后一个已关闭 chunk 之后开始；即使可见预算为 0，也不能
  // 让 archived chunks 或持久化 summary 重新泄漏回 provider 上下文。
  const lastEnd = [...selection.visible, ...selection.archived]
    .sort((a, b) => a.sequence - b.sequence)
    .at(-1)?.end_message_id
  const tailIndex = lastEnd ? messages.findIndex((msg) => msg.info.id === lastEnd) + 1 : 0
  // tail 中跳过纯 compaction checkpoint 消息（带 chunks 元数据、无真实用户文本），
  // 但保留新 /compact 命令创建的 compaction 消息（无 chunks），
  // 否则 latest() 无法拾取 compaction task，/compact 分支永远不触发。
  const tail = projectLongUserText(messages.slice(tailIndex)).filter((msg) => {
    if (msg.info.role === "assistant" && msg.info.summary) return false
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
  const archivedIDs = selection.archived.map((chunk) => chunk.display_id)
  const lines = [
    `<conversation-checkpoint strategy="chunk">`,
    ...CHECKPOINT_RULES,
    ``,
    `visible chunks: ${selection.visible.length}`,
    `archived chunks: ${selection.archived.length}`,
    `archived chunk IDs: ${archivedIDs.length > 0 ? archivedIDs.join(", ") : "none"}`,
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

/** 连续同源行只标注一次来源，同时保留每行的稳定 transcript 偏移。 */
export function formatTranscript(entries: TranscriptEntry[], indent = "") {
  return entries
    .map((entry, index) => {
      const previous = entries[index - 1]
      const prefix = !previous || previous.source !== entry.source ? `${entry.line} ${entry.source}:` : `${entry.line}:`
      return `${indent}${prefix} ${entry.text}`
    })
    .join("\n")
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
    const context = [...entries.slice(start, entry.line), ...entries.slice(entry.line + 1, entry.line + 3)]
    hits.push({ ...entry, context })
    if (hits.length >= (input.headLimit ?? 20)) break
  }
  return hits
}
