import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ulid } from "ulid"
import { PartID } from "./schema"
import type { ModelMessage } from "ai"

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

export const TRANSCRIPT_VERSION = 3
export const COMPACTION_REPLAY = "chunk_compaction_replay"
export const COMPACTION_RECOVERY = "chunk_compaction_recovery"
export const CHECKPOINT_ID = "checkpoint" as SessionV1.WithParts["info"]["id"]
/** 上下文溢出时封存当前 turn 使用的结束原因；封存前已完成的工作仍然有效，因此 chunk 记为 interrupted 而非 failed。 */
export const OVERFLOW_FINISH = "context-overflow"

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

/** 请求正文中的原生图片按媒体预算估算，Base64 传输字节不能当作文本 token。 */
export function estimateModelTokens(messages: readonly ModelMessage[]) {
  let images = 0
  const text = JSON.stringify(messages, function (this: unknown, key: string, value: unknown) {
    if (
      typeof value === "string" &&
      typeof this === "object" &&
      this !== null &&
      "type" in this &&
      ((key === "result" && this.type === "image_generation_call") ||
        // 普通工具结果使用 media.data；转换托管结果后也必须按图片估算，不能重新按 Base64 文本裁剪。
        (key === "data" && this.type === "media" && "mediaType" in this &&
          typeof this.mediaType === "string" && this.mediaType.startsWith("image/")) ||
        (key === "image" && this.type === "image") ||
        (key === "data" && this.type === "file" && "mediaType" in this &&
          typeof this.mediaType === "string" && this.mediaType.startsWith("image/")))
    ) {
      images += 1
      return undefined
    }
    return value
  })
  // 图片 token 由供应商按分辨率计费；这里保守预留固定开销，传输大小仍由媒体字节预算限制。
  return estimateTokens(text) + images * 8192
}

/** 估算一组消息投影后的 token 成本（含 JSON 结构开销） */
export function estimateMessages(msgs: { role: string; text: string }[]) {
  return msgs.reduce((total, msg) => total + estimateTokens(msg.text) + 16, 0)
}

const LONG_USER_TEXT_THRESHOLD_TOKENS = 2_000
const ARCHIVED_REQUESTS_MAX_TOKENS = 1_500
/** 单条归档请求摘录上限；约束常以多条编号列表出现，过短会把后几条截掉。 */
const ARCHIVED_REQUEST_MAX_TOKENS = 80
/** 会话首个请求往往一次性声明全局约束，单独放宽，避免只保留前一两条。 */
const FIRST_REQUEST_MAX_TOKENS = 240
const USER_TEXT_ENTRY_MAX_CHARS = 2_000

/** 首尾共享总预算，标记也计入成本；探测范围有界，避免扫描巨型文本的每个候选前缀。 */
function previewText(text: string, maxTokens: number, maxChars = Infinity) {
  if (estimateTokens(text) <= maxTokens && text.length <= maxChars) return text
  const marker = "\n[... omitted; use history tools for the full text ...]\n"
  const budget = Math.floor((maxTokens - estimateTokens(marker)) / 2)
  if (budget <= 0) return ""
  return [false, true]
    .map((tail) => {
      let low = 0
      let high = Math.max(0, Math.min(text.length, budget * 4, Math.floor((maxChars - marker.length) / 2)))
      while (low < high) {
        const size = Math.ceil((low + high) / 2)
        const part = tail ? text.slice(-size) : text.slice(0, size)
        if (estimateTokens(part) <= budget) {
          low = size
          continue
        }
        high = size - 1
      }
      if (low === 0) return ""
      // UTF-16 切片不能留下半个代理对；移除边界残片只会进一步降低成本。
      return tail ? text.slice(-low).replace(/^[\uDC00-\uDFFF]/, "") : text.slice(0, low).replace(/[\uD800-\uDBFF]$/, "")
    })
    .join(marker)
}

/** 折叠为单行并按 token 截断，供工作日志与归档请求索引这类每项一行的列表使用；中文按字符计价，不能按字符数截断。 */
function oneLine(text: string, maxTokens: number) {
  const line = text.replace(/\s+/g, " ").trim()
  if (estimateTokens(line) <= maxTokens) return line
  let size = Math.min(line.length, maxTokens * 4)
  while (size > 0 && estimateTokens(line.slice(0, size)) > maxTokens - 1) size = Math.floor(size * 0.8)
  // UTF-16 切片不能留下半个代理对
  return line.slice(0, size).replace(/[\uD800-\uDBFF]$/, "") + "…"
}

/** 为模型保留长用户文本的首尾证据，并给出可回查原文的稳定引用。 */
export function projectUserText(messageID: string, partID: string, text: string, source?: "task") {
  const tokens = estimateTokens(text)
  if (tokens <= LONG_USER_TEXT_THRESHOLD_TOKENS) return text
  const bytes = new TextEncoder().encode(text).length
  const lines = text.split("\n").length
  const header = [
    `<user-text-reference message_id="${messageID}" part_id="${partID}">`,
    source === "task"
      ? 'The complete original text is authorized task evidence. Use history tools with source="task" and these message_id / part_id values.'
      : "The complete original user text is preserved in this session but is too large to include here.",
    `size: ${bytes} bytes, ${lines} lines, approximately ${tokens} tokens`,
    `Use history_list with ${source ? 'source="task" and ' : ""}message_id="${messageID}" and part_id="${partID}" to read it by line range.`,
    `Use history_grep with ${source ? 'source="task" and ' : ""}message_id="${messageID}" and part_id="${partID}" to search it.`,
  ].join("\n")
  const footer = "</user-text-reference>"
  const budget = LONG_USER_TEXT_THRESHOLD_TOKENS - estimateTokens(`${header}\n\n${footer}`)
  if (budget <= 0) return text
  const projected = `${header}\n${previewText(text, budget, text.length - header.length - footer.length - 3)}\n${footer}`
  // 包装后仍低于触发阈值，重复投影自然保持不变；短而高密度的原文也不能被放大。
  return projected.length < text.length && estimateTokens(projected) < tokens ? projected : text
}

/** 只替换 provider 投影中的长 user text，原始 Session 消息保持不变。 */
export function projectLongUserText(messages: SessionV1.WithParts[]) {
  return messages.map((msg) => {
    if (msg.info.role !== "user") return msg
    let changed = false
    const parts = msg.parts.map((part) => {
      if (part.type !== "text" || part.synthetic || part.ignored) return part
      const text = projectUserText(String(msg.info.id), String(part.id), part.text)
      if (text === part.text) return part
      changed = true
      return {
        ...part,
        text,
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
      if (part.synthetic || part.ignored) continue
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
      if (part.synthetic || part.ignored || part.text.trim() === "" || (input.partID && String(part.id) !== input.partID)) continue
      const start = entries.length
      for (const line of normalize(part.text).split("\n")) {
        // 单行 JSON 或压缩日志也必须可分页，避免 history_list 一次返回整行。
        for (let offset = 0; offset < Math.max(line.length, 1); offset += USER_TEXT_ENTRY_MAX_CHARS) {
          entries.push({
            line: entries.length - start,
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

function chunkStatus(msg: SessionV1.WithParts): Exclude<Chunk["status"], "partial"> {
  const info = msg.info
  if (info.role !== "assistant") return "interrupted"
  if (info.error) {
    if (SessionV1.AbortedError.isInstance(info.error)) return "interrupted"
    return "failed"
  }
  if (info.finish === "stop") return "completed"
  if (info.finish === OVERFLOW_FINISH) return "interrupted"
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
  const closedIndex = closed ? input.messages.findIndex((msg) => msg.info.id === closed.end_message_id) : -1
  // 上一个 chunk 的终点不在当前消息范围内（如 compactAt 截断到更早位置）时不能从头重切，否则会产生重叠区间。
  if (closed && closedIndex < 0) return undefined
  let startIndex = closedIndex + 1
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
  // 进行中折叠出的 partial chunk 与它所在 turn 的结束合并为同一个 chunk：区间起点与 ID 不变，只延长终点。
  if (closed?.status === "partial") {
    const { index_tokens: _, ...rest } = closed
    return { ...rest, end_message_id: end.info.id, status: chunkStatus(end) }
  }
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

/** 把 closeChunk / foldChunk 的结果并入列表：同一 chunk_key 视为延长最后一个 chunk，否则追加。 */
export function appendChunk(chunks: Chunk[], next: Chunk) {
  if (chunks.at(-1)?.chunk_key === next.chunk_key) chunks[chunks.length - 1] = next
  else chunks.push(next)
  return chunks
}

/** 已有一步完整结果的 assistant：工具调用与结果都已结算，可以作为折叠的步边界。 */
function isStep(msg: SessionV1.WithParts) {
  return msg.info.role === "assistant" && !msg.info.summary && msg.parts.some((part) => part.type !== "step-start")
}

/**
 * provider 请求中一条消息的近似成本：只计会下发的正文（文本、推理、工具入参与结果、图片），
 * 不计 UI 元数据（edit 的 filediff 等可能比正文大数倍）。
 */
export function estimateMessage(msg: SessionV1.WithParts) {
  let images = 0
  const body = msg.parts.flatMap((part) => {
    if (part.type === "text" || part.type === "reasoning") return [part.text]
    if (part.type === "tool") {
      const state = part.state
      const output = state.status === "completed" ? state.output : state.status === "error" ? state.error : ""
      return [part.tool, safeJSON(state.input), output]
    }
    if (part.type === "file") {
      if (part.mime.startsWith("image/")) images++
      return [part.filename ?? ""]
    }
    return []
  })
  return estimateTokens(body.join("\n")) + 16 + images * 8192
}

/** 最后一个已关闭 chunk 之后的开放区间（跳过压缩脚手架）；上一个 chunk 终点不在消息中时没有可折叠区间。 */
export function openRegion(messages: SessionV1.WithParts[], chunks: Chunk[]) {
  const closed = chunks.at(-1)
  const closedIndex = closed ? messages.findIndex((msg) => msg.info.id === closed.end_message_id) : -1
  if (closed && closedIndex < 0) return [] as SessionV1.WithParts[]
  return messages.slice(closedIndex + 1).filter((msg) => !isCompactionScaffold(msg))
}

/**
 * 进行中 turn 的折叠终点：从最新一步往前累加原文，直到保留部分超出 budget；只在 assistant 步边界切，
 * 最新一步永远保留原文。最新一步本身就超出预算时尽量多折（只留最新一步）。没有可折叠的步时返回 undefined。
 */
export function foldPoint(input: {
  messages: SessionV1.WithParts[]
  chunks: Chunk[]
  budget: number
  estimate?: (msg: SessionV1.WithParts) => number
}) {
  const region = openRegion(input.messages, input.chunks)
  const latest = region.findLastIndex(isStep)
  const estimate = input.estimate ?? estimateMessage
  let kept = 0
  let cut: SessionV1.WithParts | undefined
  for (let i = region.length - 1; i >= 0; i--) {
    const msg = region[i]!
    // 切在 i 之后：i 是更早的完整步，且 i 之后（含最新一步）的原文放得下，或者还没有任何切点
    if (i < latest && isStep(msg) && !hasOpenToolCalls(msg) && (kept <= input.budget || !cut)) cut = msg
    kept += estimate(msg)
    if (kept > input.budget && cut) break
  }
  // 整个开放区间都放得下：超限来自区间之外（system、tools、更早 chunk），折叠本轮无济于事
  if (kept <= input.budget) return undefined
  return cut?.info.id
}

/**
 * 把开放区间折叠到 endMessageID（含）：最后一个 chunk 已是 partial（同一 turn 再次折叠）时延长它，
 * 状态索引随之合并；否则新建 partial chunk。
 */
export function foldChunk(input: {
  messages: SessionV1.WithParts[]
  chunks: Chunk[]
  endMessageID: SessionV1.WithParts["info"]["id"]
  indexTokens: number
}): Chunk | undefined {
  const closed = input.chunks.at(-1)
  if (closed?.status === "partial")
    return { ...closed, end_message_id: input.endMessageID, index_tokens: input.indexTokens }
  const region = openRegion(input.messages, input.chunks)
  const endIndex = region.findIndex((msg) => msg.info.id === input.endMessageID)
  if (endIndex < 0) return undefined
  return {
    chunk_key: ulid(),
    display_id: displayID(input.chunks),
    sequence: (closed?.sequence ?? 0) + 1,
    start_message_id: region[0]!.info.id,
    end_message_id: input.endMessageID,
    status: "partial",
    index_tokens: input.indexTokens,
  }
}

// ---------------------------------------------------------------------------
// 进行中 turn 的状态索引：确定性地从折叠步骤提取，不经过模型
// ---------------------------------------------------------------------------

const FILE_TOOLS = new Set(["edit", "write", "multiedit", "apply_patch"])
const SEARCH_TOOLS = new Set(["grep", "glob", "list", "list_dir"])
const DEFAULT_INDEX_TOKENS = 8_000

type WorkIndex = {
  steps: number
  files: Map<string, { count: number; first: number; last: number; diffs: { step: number; lines: string[] }[] }>
  errors: { step: number; key: string; what: string; detail: string; resolved?: number }[]
  narration: { step: number; text: string }[]
  reads: Map<string, number[]>
  searches: Map<string, { steps: number[]; head: string }>
  commands: { step: number; command: string; exit: unknown; lines: number; tail: string[] }[]
  other: Map<string, number[]>
}

function relative(file: string, cwd: string | undefined) {
  if (!cwd) return file
  const root = cwd.endsWith("/") ? cwd : cwd + "/"
  return file.startsWith(root) ? file.slice(root.length) : file
}

/** 行级增删：只给出改动行，纯插入时附一行定位上下文。 */
function editLines(before: string, after: string) {
  const old = before.split("\n")
  const next = after.split("\n")
  const lines = [
    ...old.filter((line) => line.trim() && !next.includes(line)).map((line) => `- ${oneLine(line, 40)}`),
    ...next.filter((line) => line.trim() && !old.includes(line)).map((line) => `+ ${oneLine(line, 40)}`),
  ]
  const anchor = old.find((line) => line.trim() && next.includes(line))
  return [
    ...lines.slice(0, 6),
    ...(lines.length > 6 ? [`… ${lines.length - 6} more changed lines`] : []),
    ...(anchor && lines.every((line) => line.startsWith("+")) ? [`@ ${oneLine(anchor, 40)}`] : []),
  ]
}

function patchLines(patch: string) {
  return editLines(
    patch.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).map((line) => line.slice(1)).join("\n"),
    patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1)).join("\n"),
  )
}

function fileChanges(part: SessionV1.ToolPart, cwd: string | undefined): { file: string; lines: string[] }[] {
  if (part.state.status !== "completed") return []
  const input = part.state.input ?? {}
  if (part.tool === "edit")
    return [{ file: relative(String(input.filePath ?? ""), cwd), lines: editLines(String(input.oldString ?? ""), String(input.newString ?? "")) }]
  if (part.tool === "write")
    return [{ file: relative(String(input.filePath ?? ""), cwd), lines: editLines("", String(input.content ?? "")) }]
  if (part.tool === "multiedit") {
    const edits = Array.isArray(input.edits) ? input.edits : []
    return edits.map((edit: any) => ({
      file: relative(String(edit?.filePath ?? input.filePath ?? ""), cwd),
      lines: editLines(String(edit?.oldString ?? ""), String(edit?.newString ?? "")),
    }))
  }
  const files = part.state.metadata?.files
  if (!Array.isArray(files)) return []
  return files.flatMap((file) => {
    const name = file?.movePath ?? file?.filePath ?? file?.relativePath
    if (typeof name !== "string") return []
    return [{ file: relative(name, cwd), lines: typeof file?.patch === "string" ? patchLines(file.patch) : [] }]
  })
}

function failedTool(part: SessionV1.ToolPart) {
  if (part.state.status === "error") return true
  if (part.state.status !== "completed") return false
  const exit = part.state.metadata?.exit
  return typeof exit === "number" && exit !== 0
}

/** 同一目标后续成功即视为该错误已解决：文件写入按文件，命令按命令文本，其余按工具与入参。 */
function errorKey(part: SessionV1.ToolPart, cwd: string | undefined) {
  const input = part.state.input ?? {}
  if (FILE_TOOLS.has(part.tool) && typeof input.filePath === "string") return `file:${relative(input.filePath, cwd)}`
  if (typeof input.command === "string") return `command:${input.command}`
  return `${part.tool}:${safeJSON(input)}`
}

function workIndex(region: SessionV1.WithParts[]): WorkIndex {
  const index: WorkIndex = {
    steps: 0,
    files: new Map(),
    errors: [],
    narration: [],
    reads: new Map(),
    searches: new Map(),
    commands: [],
    other: new Map(),
  }
  for (const msg of region) {
    if (!isStep(msg)) continue
    const step = ++index.steps
    const cwd = msg.info.role === "assistant" ? msg.info.path?.cwd : undefined
    const text = msg.parts.flatMap((part) => (part.type === "text" && part.text.trim() ? [part.text] : [])).join(" ")
    if (text) index.narration.push({ step, text: oneLine(text, 60) })
    for (const part of msg.parts) {
      if (part.type !== "tool") continue
      const input = part.state.input ?? {}
      const key = errorKey(part, cwd)
      if (failedTool(part)) {
        const what = typeof input.command === "string"
          ? `${part.tool} \`${oneLine(input.command, 40)}\``
          : `${part.tool} ${key.startsWith("file:") ? key.slice(5) : oneLine(safeJSON(input), 40)}`
        const raw = part.state.status === "error" ? part.state.error : part.state.status === "completed" ? part.state.output : ""
        const detail = previewText(String(raw ?? "").trim().split("\n").slice(0, 8).join("\n"), 200)
        index.errors.push({ step, key, what, detail })
        continue
      }
      if (part.state.status !== "completed") continue
      for (const error of index.errors) if (!error.resolved && error.key === key) error.resolved = step
      if (FILE_TOOLS.has(part.tool)) {
        for (const change of fileChanges(part, cwd)) {
          if (!change.file) continue
          const entry = index.files.get(change.file) ?? { count: 0, first: step, last: step, diffs: [] }
          entry.count++
          entry.last = step
          entry.diffs.push({ step, lines: change.lines })
          if (entry.diffs.length > 3) entry.diffs.shift()
          index.files.set(change.file, entry)
        }
        continue
      }
      if (part.tool === "read" && typeof input.filePath === "string") {
        const file = relative(input.filePath, cwd)
        index.reads.set(file, [...(index.reads.get(file) ?? []), step])
        continue
      }
      if (SEARCH_TOOLS.has(part.tool)) {
        const target = typeof input.path === "string" ? ` in ${relative(input.path, cwd)}` : ""
        const include = typeof input.include === "string" ? ` (${input.include})` : ""
        const searchKey = `${part.tool} ${typeof input.pattern === "string" ? input.pattern : ""}${target}${include}`.replace(/\s+/g, " ")
        const entry = index.searches.get(searchKey) ?? { steps: [], head: "" }
        entry.steps.push(step)
        entry.head = oneLine(part.state.output.trim().split("\n")[0] ?? "", 25)
        index.searches.set(searchKey, entry)
        continue
      }
      if (typeof input.command === "string") {
        const lines = part.state.output.trim().split("\n")
        index.commands.push({
          step,
          command: oneLine(input.command, 40),
          exit: part.state.metadata?.exit,
          lines: lines.length,
          tail: lines.slice(-3).map((line) => oneLine(line, 40)),
        })
        continue
      }
      const otherKey = `${part.tool} ${oneLine(safeJSON(input), 40)}`
      index.other.set(otherKey, [...(index.other.get(otherKey) ?? []), step])
    }
  }
  return index
}

function stepList(steps: number[]) {
  return `step${steps.length > 1 ? "s" : ""} ${steps.join(",")}${steps.length > 1 ? `; ${steps.length} times` : ""}`
}

function renderWorkState(
  index: WorkIndex,
  chunk: Chunk,
  budget: { narration?: number; diffFiles: number; lists?: number },
) {
  const fit = (lines: string[], tokens: number | undefined) =>
    tokens === undefined || lines.length === 0 ? lines : previewLines(lines, tokens).split("\n")
  const out = [
    `<work-state chunk="${chunk.display_id}" status="partial" folded-steps="1-${index.steps}">`,
    // 真模型实测：只说“可用 history 工具取回”时，模型会凭印象回答已折叠文件的内容，必须明确原文已不在上下文
    `This turn is still in progress. Steps 1-${index.steps} were folded to free context: their tool outputs (file contents, search hits, command output) are no longer in your context, only this index is. The messages after it are the later steps, verbatim. Continue the current task from the latest step and do not redo folded steps. Do not answer from memory about folded output: when you need its exact text, call history_grep or history_list with chunk_id="${chunk.display_id}", or run the tool again.`,
  ]
  const files = [...index.files]
  out.push("", `## Modified files (${files.length})`)
  files.forEach(([file, entry], i) => {
    out.push(`- ${file}: ${entry.count} change${entry.count > 1 ? "s" : ""} (step ${entry.first}${entry.last !== entry.first ? `-${entry.last}` : ""})`)
    // 预算紧时只给最近修改的文件保留 diff；文件列表本身永不省略
    if (i < files.length - budget.diffFiles) return
    for (const diff of entry.diffs) out.push(`  step ${diff.step}:`, ...diff.lines.map((line) => `    ${line}`))
  })
  const errors = index.errors.map((error) =>
    error.resolved
      ? `- step ${error.step} ${error.what} (resolved at step ${error.resolved})${budget.lists === undefined ? `: ${error.detail.replace(/\n/g, "\n    ")}` : ""}`
      : `- step ${error.step} ${error.what} (UNRESOLVED): ${error.detail.replace(/\n/g, "\n    ")}`,
  )
  out.push("", `## Errors (${index.errors.length})`, ...errors)
  out.push("", `## Steps`, ...fit(index.narration.map((item) => `- ${item.step}. ${item.text}`), budget.narration))
  const reads = [...index.reads].map(([file, steps]) => `- ${file} @ ${steps.join(",")}`)
  out.push("", `## Files read (${reads.length}; contents folded, re-read or history_grep before relying on them)`, ...fit(reads, budget.lists))
  const searches = [...index.searches].map(([key, entry]) => `- ${key} → ${entry.head || "(no output)"} (${stepList(entry.steps)})`)
  out.push("", `## Searches (${searches.length})`, ...fit(searches, budget.lists))
  const commands = index.commands.map((command) =>
    [`- ${command.step}. \`${command.command}\` exit=${command.exit ?? "?"}, ${command.lines} output lines, last ${command.tail.length}:`, ...command.tail.map((line) => `    ${line}`)].join("\n"),
  )
  out.push("", `## Commands (${commands.length})`, ...fit(commands, budget.lists))
  if (index.other.size > 0) {
    const other = [...index.other].map(([key, steps]) => `- ${key} (${stepList(steps)})`)
    out.push("", `## Other tool calls (${other.length})`, ...fit(other, budget.lists))
  }
  out.push(`</work-state>`)
  return out.join("\n")
}

/**
 * 进行中 turn 被折叠部分的状态索引，整体不超过 maxTokens：
 * 先压缩每步说明，再只给最近 20/10/5 个文件保留 diff，最后压缩读取、搜索与命令列表；修改文件列表永不省略。
 */
export function workState(region: SessionV1.WithParts[], chunk: Chunk, maxTokens = chunk.index_tokens ?? DEFAULT_INDEX_TOKENS) {
  const index = workIndex(region)
  const full = renderWorkState(index, chunk, { diffFiles: Infinity })
  if (estimateTokens(full) <= maxTokens) return full
  const empty = { ...index, narration: [] }
  for (const diffFiles of [Infinity, 20, 10, 5]) {
    const fixed = estimateTokens(renderWorkState(empty, chunk, { diffFiles }))
    if (fixed > maxTokens * 0.7) continue
    return renderWorkState(index, chunk, { narration: Math.max(500, maxTokens - fixed), diffFiles })
  }
  const lists = Math.max(300, Math.floor(maxTokens * 0.1))
  const fixed = estimateTokens(renderWorkState(empty, chunk, { diffFiles: 0, lists }))
  return renderWorkState(index, chunk, { narration: Math.max(500, maxTokens - fixed), diffFiles: 0, lists })
}

function chunkRegion(messages: SessionV1.WithParts[], chunk: Chunk, positions: Map<SessionV1.WithParts["info"]["id"], number>) {
  const start = positions.get(chunk.start_message_id)
  const end = positions.get(chunk.end_message_id)
  if (start === undefined || end === undefined || end < start) return [] as SessionV1.WithParts[]
  return messages.slice(start, end + 1)
}

/** chunk 的模型可见文本：全部 user 原文 + 终态 assistant 可见文本 */
function chunkContent(region: SessionV1.WithParts[], chunk: Chunk, compact = false) {
  // 收集区间内全部真实 user 原文
  let seq = 0
  const userBlocks = region.flatMap((msg) => {
    if (msg.info.role !== "user") return []
    return textParts(msg)
      .filter((part) => !part.synthetic && !part.ignored && part.text.trim() !== "")
      .map((part) => `<user-message sequence="${++seq}">\n${projectUserText(String(msg.info.id), String(part.id), part.text)}\n</user-message>`)
  })
  const reference = `Use history_list with chunk_id="${chunk.display_id}" or history_grep to recover omitted details.`
  // 进行中 turn：用户原文完整保留，折叠步骤换成状态索引；后续步骤作为 active tail 原样跟在后面。
  if (chunk.status === "partial") {
    const input = userBlocks.length === 0
      ? ""
      : [`<chunk-input id="${chunk.display_id}" status="partial">`, ...userBlocks, "</chunk-input>"].join("\n")
    const summary = workState(region, chunk)
    const tokens = estimateMessages([...(input ? [{ role: "user", text: input }] : []), { role: "assistant", text: summary }])
    return { input, summary, tokens }
  }
  const input = userBlocks.length === 0
    ? ""
    : [
        `<chunk-input id="${chunk.display_id}" status="${chunk.status}"${compact ? ' excerpt="true"' : ""}>`,
        compact ? previewText(userTexts(region).join("\n\n"), 600) : userBlocks.join("\n\n"),
        ...(compact ? [reference] : []),
        "</chunk-input>",
      ].join("\n")
  // 终态 assistant 的可见 text parts
  const final = finalTexts(region.at(-1)).join("\n\n")
  const recent = region
    .flatMap((msg) => msg.parts)
    .filter((part): part is SessionV1.ToolPart => part.type === "tool")
    .slice(-3)
  // 最近结果所在消息的说明文字跟随工具调用一起展示，不能拆到上方工作日志里与调用错位。
  const recentMessages = new Set(region.filter((msg) => msg.parts.some((part) => recent.includes(part as SessionV1.ToolPart))))
  // 溢出常发生在长 turn 中途，只剩最近 3 个结果会让模型重做早先已完成的读取与修改；
  // 更早的步骤按时间顺序折叠成每步一行的工作日志，整体有界并保留首尾。
  const log = region.flatMap((msg, index) =>
    chunk.status === "completed" || msg.info.role !== "assistant" || recentMessages.has(msg)
      ? []
      : msg.parts.flatMap((part) => {
          // 最后一条 assistant 的文本已作为 final 展示
          if (part.type === "text" && index < region.length - 1 && part.text.trim())
            return [`- ASSISTANT: ${oneLine(part.text, 50)}`]
          if (part.type === "tool")
            return [`- ${part.tool}(${oneLine(safeJSON(part.state.input), 40)}) [${part.state.status}]`]
          return []
        }),
  )
  const recentEntries = region.flatMap((msg, index) =>
    recentMessages.has(msg)
      ? msg.parts.flatMap((part) => {
          if (part.type === "text" && index < region.length - 1 && part.text.trim())
            return [`ASSISTANT: ${oneLine(part.text, 50)}`]
          if (part.type === "tool" && recent.includes(part))
            return toolTranscript(part).map(
              (entry) => `${entry.source}: ${previewText(entry.text, entry.source === "ASSISTANT_TOOL" ? 180 : 360)}`,
            )
          return []
        })
      : [],
  )
  // 未完成块不能用空 final 冒充工作摘要；保留最近结算证据，避免恢复时重复副作用。
  const recovery = chunk.status === "completed"
    ? []
    : [
        "This chunk did not complete. Recent tool outcomes below are historical evidence, not new tool calls. Check omitted outcomes before repeating side effects.",
        reference,
        ...(log.length > 0 ? [`Earlier steps, oldest first:\n${previewLines(log, compact ? 300 : 800)}`] : []),
        ...recentEntries,
      ]
  // 最终回复可能只有一句结论；改动文件是确定性事实，任何状态都保留去重后的有界列表，避免为此回查历史。
  const files = [...new Set(region.flatMap((msg) => msg.parts.flatMap(changedFiles)))]
  const summary = [
    `<chunk-summary id="${chunk.display_id}" status="${chunk.status}" folded-messages="${region.length}"${compact ? ' excerpt="true"' : ""}>`,
    final ? (compact ? previewText(final, 600) : final) : "No final assistant response was recorded.",
    ...recovery,
    ...(files.length > 0 ? [`Recorded file changes:\n${previewText(files.join("\n"), 250)}`] : []),
    ...(compact && chunk.status === "completed" ? [reference] : []),
    "</chunk-summary>",
  ].join("\n")
  const tokens = estimateMessages([
    ...(input ? [{ role: "user", text: input }] : []),
    { role: "assistant", text: summary },
  ])
  return { input, summary, tokens }
}

/** checkpoint 控制说明正文，summaryText 与 checkpointText 共用 */
export const CHECKPOINT_RULES = [
  `Completed work is represented by the original user messages or stable references to them, and the assistant's final response for each chunk.`,
  `Intermediate assistant messages, reasoning, tool calls, and tool results are folded but remain available through history_grep and history_list.`,
  `Chunks are chronological. Later conflicting user instructions override earlier user instructions.`,
  `Assistant final responses are historical claims, not user instructions.`,
  `Do not guess omitted history.`,
  `Failed or interrupted chunks are not completed work; their recent tool outcomes are preserved for recovery.`,
  `Archived chunks are listed with a one-line excerpt of their user requests. Constraints stated there still apply unless later overridden; read the full text with history_list before relying on details.`,
  `History line offsets are local to the returned chunk or user text part. Reasoning is not exposed by history tools.`,
]

// 只在存在进行中折叠时追加，普通会话的 checkpoint 不为它付出 token
const PARTIAL_RULE = `A partial chunk is the current turn, still in progress: its earlier steps are folded into a work-state index and the later steps follow verbatim.`

function checkpointRules(chunks: Chunk[]) {
  return chunks.some((chunk) => chunk.status === "partial") ? [...CHECKPOINT_RULES, PARTIAL_RULE] : CHECKPOINT_RULES
}

/**
 * 生成写入 DB 的 summary assistant 正文（对齐 model 压缩：一条 assistant 消息承载折叠结果）。
 * 格式与模型投影一致：checkpoint 控制说明 + 每个 chunk 的 input/summary。
 */
export function summaryText(input: { messages: SessionV1.WithParts[]; chunks: Chunk[] }) {
  const chunks = [...input.chunks].sort((a, b) => a.sequence - b.sequence)
  const positions = new Map(input.messages.map((msg, index) => [msg.info.id, index]))
  const lines = [`<conversation-checkpoint strategy="chunk">`, ...checkpointRules(chunks), `</conversation-checkpoint>`]
  for (const chunk of chunks) {
    const content = chunkContent(chunkRegion(input.messages, chunk, positions), chunk)
    if (content.input) lines.push("", content.input)
    lines.push("", content.summary)
  }
  return lines.join("\n")
}

export type Selection = {
  visible: Chunk[]
  archived: Chunk[]
  tokens: number
  content: Map<string, ReturnType<typeof chunkContent>>
  /** display_id -> 该 chunk 用户请求的单行摘录；覆盖全部 chunk，发送前裁剪把可见块转为归档时无需重算。 */
  requests: Map<string, string>
}

/**
 * 从最新向最旧选择连续最新后缀，加入后超过预算即停止。
 * 全文只能占用 target；全文放不下时改用更小的有界摘录，摘录可使用 target 到 hard 之间的余量。
 * final response 过大导致单 chunk 超 hard 时，该 chunk 整体移出可见集，
 * 由调用方决定 fallback 或折叠指针。
 * 先尝试有界摘录与回查指针；只有降级后仍无法容纳，才整体归档并停止后缀选择。
 * 最新 chunk 未完成时是续跑的唯一现场证据，无论预算都保留（优先全文，放不下用摘录）。
 */
export function selectVisible(input: {
  messages: SessionV1.WithParts[]
  chunks: Chunk[]
  targetTokens: number
  hardTokens: number
}): Selection {
  const chunks = [...input.chunks].sort((a, b) => a.sequence - b.sequence)
  const positions = new Map(input.messages.map((msg, index) => [msg.info.id, index]))
  const visible: Chunk[] = []
  const content: Selection["content"] = new Map()
  const limit = Math.min(input.targetTokens, input.hardTokens)
  let total = 0
  for (let i = chunks.length - 1; i >= 0; i--) {
    const chunk = chunks[i]!
    const region = chunkRegion(input.messages, chunk, positions)
    const full = chunkContent(region, chunk)
    // 近处全文放满 target 后，更早的 chunk 降级为摘录继续占用余量，而不是在第一块放不下的全文处整体截断。
    const compact = total + full.tokens > limit ? chunkContent(region, chunk, true) : undefined
    const selected = compact && compact.tokens < full.tokens ? compact : full
    // 溢出封存的 turn 若被归档，续跑只剩一行请求摘录，模型会重做已完成的读取与修改；其摘录本身有界。
    const resuming = i === chunks.length - 1 && chunk.status !== "completed"
    // final response 过大导致整 chunk 超硬上限：整 chunk 不可见，继续更早 chunk 无意义（规则 6 禁止跳大挑小）
    if (!resuming && total + selected.tokens > input.hardTokens) break
    // 进行中 turn 的状态索引有自己的上限（按模型上下文确定），不挤占更早 chunk 的历史预算。
    if (chunk.status !== "partial") total += selected.tokens
    visible.unshift(chunk)
    content.set(chunk.display_id, selected)
  }
  const archived = chunks.slice(0, chunks.length - visible.length)
  // 归档后用户原文全部离开可见窗口，早期约束会被遗忘；为每个有真实用户文本的 chunk 保留单行摘录。
  const requests = new Map(
    chunks.flatMap((chunk, index) => {
      const texts = userTexts(chunkRegion(input.messages, chunk, positions))
      const max = index === 0 ? FIRST_REQUEST_MAX_TOKENS : ARCHIVED_REQUEST_MAX_TOKENS
      return texts.length > 0 ? [[chunk.display_id, oneLine(texts.join(" / "), max)] as const] : []
    }),
  )
  return { visible, archived, tokens: total, content, requests }
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
  const user = messages.find((msg) => msg.info.role === "user")
  if (user?.info.role !== "user") return messages
  const sessionID = user.info.sessionID
  const positions = new Map(messages.map((msg, index) => [msg.info.id, index]))

  // checkpoint 控制说明作为第一条 user 消息注入，不是 system context
  const checkpoint = checkpointText({ selection, targetTokens, hardTokens })
  result.push({
    info: { ...user.info, id: CHECKPOINT_ID, time: { created: 0 } },
    parts: [{ id: PartID.make("prt_chunk_checkpoint"), messageID: CHECKPOINT_ID, sessionID, type: "text", text: checkpoint, synthetic: true }],
  })

  for (const chunk of selection.visible) {
    const content = selection.content.get(chunk.display_id)!
    // 进行中折叠会把 holder（agent=compaction）放进本 chunk 区间，不能让它决定投影 user 的 agent/model
    const chunkUser = chunkRegion(messages, chunk, positions).findLast(
      (msg) => msg.info.role === "user" && !msg.parts.some((part) => part.type === "compaction"),
    )
    if (content.input) {
      result.push({
        info: { ...(chunkUser?.info.role === "user" ? chunkUser.info : user.info), id: chunk.start_message_id },
        parts: [{
          id: PartID.make(`prt_chunk_${chunk.display_id}_input`),
          messageID: chunk.start_message_id,
          sessionID,
          type: "text",
          text: content.input,
          synthetic: true,
        }],
      })
    }
    const finalMsg = messages[positions.get(chunk.end_message_id)!]
    if (finalMsg?.info.role === "assistant") {
      result.push({
        // 原始失败状态保留在 DB 和正文中，不能让 provider 转换器丢弃这条恢复投影。
        info: { ...finalMsg.info, error: undefined },
        parts: [{
          id: PartID.make(`prt_chunk_${chunk.display_id}_summary`),
          messageID: chunk.end_message_id,
          sessionID,
          type: "text",
          text: content.summary,
          synthetic: true,
        }],
      })
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
  selection: Selection
  targetTokens: number
  hardTokens: number
}) {
  const { selection } = input
  const visibleSeq = selection.visible.map((chunk) => chunk.sequence)
  const archivedIDs = selection.archived.map((chunk) => chunk.display_id)
  const requests = selection.archived.flatMap((chunk) => {
    const request = selection.requests.get(chunk.display_id)
    return request ? [`- ${chunk.display_id} [${chunk.status}]: ${request}`] : []
  })
  const lines = [
    `<conversation-checkpoint strategy="chunk">`,
    ...checkpointRules(selection.visible),
    ``,
    `visible chunks: ${selection.visible.length}`,
    `archived chunks: ${selection.archived.length}`,
    `archived chunk IDs: ${archivedIDs.length > 0 ? archivedIDs.join(", ") : "none"}`,
    `visible sequences: ${visibleSeq.length > 0 ? `${visibleSeq[0]}..${visibleSeq.at(-1)}` : "none"}`,
    `history budget: ${selection.tokens}/${input.targetTokens} tokens (hard ${input.hardTokens})`,
    // 索引整体有界；超限时保留最早与最近的归档请求，最早的往往承载整个会话的约束。
    ...(requests.length > 0
      ? [`archived requests, oldest first:`, previewText(requests.join("\n"), ARCHIVED_REQUESTS_MAX_TOKENS)]
      : []),
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
  source: "USER" | "ASSISTANT" | "ASSISTANT_TOOL" | "TOOL_OUTPUT" | "TOOL_ERROR" | "PATCH" | "SHELL"
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
  // 只统一换行；路径、转义和标点属于原文证据，不能在读取时改写。
  return text.replace(/\r\n/g, "\n")
}

/** chunk 历史和授权任务证据共用同一片段投影，不暴露隐藏推理或 provider 元数据。 */
export function partTranscript(role: SessionV1.Info["role"], part: SessionV1.Part) {
  const blocks: { source: TranscriptEntry["source"]; text: string }[] = []
  if (role === "user" && part.type === "text" && !part.synthetic && !part.ignored) {
    blocks.push({ source: "USER", text: part.text })
  }
  if (role === "assistant") {
    if (part.type === "text") blocks.push({ source: "ASSISTANT", text: part.text })
    if (part.type === "patch") blocks.push({ source: "PATCH", text: part.files.join("\n") })
    if (part.type === "tool") blocks.push(...toolTranscript(part))
  }
  return blocks
    .flatMap((block) => normalize(block.text).split("\n").map((text) => ({ source: block.source, text })))
    .map((entry, line) => ({ ...entry, line }))
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
  const positions = new Map(input.messages.map((msg, index) => [msg.info.id, index]))
  const byID = new Map(input.chunks.map((chunk) => [chunk.start_message_id, chunk]))
  for (let i = 0; i < input.messages.length; i++) {
    const msg = input.messages[i]!
    const chunk = byID.get(msg.info.id)
    if (!chunk) continue
    const region = chunkRegion(input.messages, chunk, positions)
    if (region.length === 0) continue
    // 行号属于 chunk，不随检索范围或更早历史的行数变化。
    const local: TranscriptEntry[] = []
    for (const item of region) {
      for (const part of item.parts) {
        for (const entry of partTranscript(item.info.role, part)) {
          local.push({ ...entry, chunk, line: local.length })
        }
      }
    }
    for (const entry of local) entries.push(entry)
    i += region.length - 1
  }
  return entries
}

/** 恢复摘录与历史检索共用工具事实，失败前已产生的部分输出也必须可回查。 */
/** 文件改动来自写入类工具的完成结果（patch part 已不再生成，仍兼容旧会话里的记录）。 */
function changedFiles(part: SessionV1.Part): string[] {
  if (part.type === "patch") return part.files
  if (part.type !== "tool" || part.state.status !== "completed") return []
  if (part.tool === "apply_patch") {
    const files = part.state.metadata?.files
    if (!Array.isArray(files)) return []
    return files.flatMap((file) => {
      const value = file?.movePath ?? file?.filePath ?? file?.relativePath
      return typeof value === "string" ? [value] : []
    })
  }
  if (part.tool !== "write" && part.tool !== "edit" && part.tool !== "multiedit") return []
  const filePath = part.state.input?.filePath
  return typeof filePath === "string" ? [filePath] : []
}

/** 按整行保留首尾，中间整行省略；避免字符级截断把某一步切成半行、丢失步骤边界。 */
function previewLines(lines: string[], maxTokens: number) {
  const text = lines.join("\n")
  if (estimateTokens(text) <= maxTokens) return text
  const marker = (count: number) => `- [... ${count} steps omitted; use history tools for the full text ...]`
  const budget = maxTokens - estimateTokens(marker(lines.length))
  const head: string[] = []
  const tail: string[] = []
  let used = 0
  let i = 0
  let j = lines.length - 1
  // 首尾交替取整行，保证最早的起点与最近的进展都可见。
  while (i <= j) {
    const fromHead = head.length <= tail.length
    const line = fromHead ? lines[i]! : lines[j]!
    const cost = estimateTokens(line + "\n")
    if (used + cost > budget) break
    used += cost
    if (fromHead) head.push(lines[i++]!)
    else tail.unshift(lines[j--]!)
  }
  const omitted = j - i + 1
  return [...head, ...(omitted > 0 ? [marker(omitted)] : []), ...tail].join("\n")
}

function toolTranscript(part: SessionV1.ToolPart) {
  const entries: { source: TranscriptEntry["source"]; text: string }[] = [{
    source: "ASSISTANT_TOOL",
    text: `${part.tool}(${safeJSON(part.state.input)}) [${part.state.status}, call=${part.callID}]`,
  }]
  if (part.state.status === "completed") entries.push({ source: "TOOL_OUTPUT", text: part.state.output })
  if (part.state.status === "error") {
    const output = part.state.output ?? (part.state.metadata?.interrupted === true ? part.state.metadata.output : undefined)
    if (typeof output === "string" && output.length > 0) entries.push({ source: "TOOL_OUTPUT", text: output })
    entries.push({ source: "TOOL_ERROR", text: part.state.error })
  }
  return entries
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
  const entries = transcript({
    messages: input.messages,
    chunks: input.chunkID ? input.chunks.filter((chunk) => chunk.display_id === input.chunkID) : input.chunks,
  })
  for (const [index, entry] of entries.entries()) {
    const haystack = input.caseSensitive ? entry.text : entry.text.toLowerCase()
    if (!haystack.includes(needle)) continue
    const start = Math.max(0, index - 2)
    const context = [...entries.slice(start, index), ...entries.slice(index + 1, index + 3)]
      .filter((neighbor) => neighbor.chunk.display_id === entry.chunk.display_id)
    hits.push({ ...entry, context })
    if (hits.length >= (input.headLimit ?? 20)) break
  }
  return hits
}
