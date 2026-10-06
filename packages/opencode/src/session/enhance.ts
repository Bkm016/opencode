import type { SessionV1 } from "@opencode-ai/core/v1/session"

/**
 * 提示词优化：把用户还没发出去的话改写得更清楚。
 * 价值主要在补上下文（把"那个""刚才"换成具体对象、带上对话里说过的约束），不是润色措辞。
 */

/** 改写时参考的最近消息条数 */
export const RECENT = 12
const MESSAGE_LIMIT = 1500
const TRANSCRIPT_LIMIT = 12_000

function clip(text: string, limit: number) {
  const value = text.trim()
  if (value.length <= limit) return value
  return value.slice(0, limit) + " …"
}

function describeTool(part: Extract<SessionV1.WithParts["parts"][number], { type: "tool" }>) {
  const input = (part.state.status === "pending" ? undefined : part.state.input) as Record<string, unknown> | undefined
  const target = [input?.filePath, input?.path, input?.command, input?.pattern, input?.url].find(
    (item): item is string => typeof item === "string" && item.length > 0,
  )
  return target ? `[${part.tool}: ${clip(target, 200)}]` : `[${part.tool}]`
}

/** 把最近的对话压成纯文本：用户与助手的正文，工具调用只留名字和目标 */
export function transcript(messages: SessionV1.WithParts[]) {
  const blocks = messages.flatMap((message) => {
    const lines = message.parts.flatMap((part) => {
      if (part.type === "text" && !part.synthetic && !part.ignored) return [clip(part.text, MESSAGE_LIMIT)]
      if (part.type === "file") return [`[file: ${part.filename ?? part.url}]`]
      if (part.type === "tool") return [describeTool(part)]
      return []
    })
    const body = lines.filter(Boolean).join("\n")
    if (!body) return []
    return [`${message.info.role === "user" ? "User" : "Agent"}:\n${body}`]
  })
  // 从最新往回取，总长度封顶
  const kept: string[] = []
  let size = 0
  for (const block of blocks.toReversed()) {
    if (size + block.length > TRANSCRIPT_LIMIT) break
    kept.unshift(block)
    size += block.length
  }
  return kept.join("\n\n")
}

export type Answer = { question: string; answer: string }

export const QUESTIONS_TAG = "<questions>"

/** 模型需要先问清楚时会输出 <questions> 块：Q: 开头是问题，- 开头是候选回答 */
export function parseQuestions(output: string) {
  const text = output.trim()
  if (!text.startsWith(QUESTIONS_TAG)) return
  const body = text.slice(QUESTIONS_TAG.length).replace(/<\/questions>[\s\S]*$/, "")
  const list: { question: string; options: string[] }[] = []
  for (const raw of body.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    const question = line.match(/^(?:Q\d*\s*[:：.]|\d+\s*[.)、])\s*(.+)$/i)
    if (question) {
      list.push({ question: question[1].trim(), options: [] })
      continue
    }
    const option = line.match(/^[-*•]\s*(.+)$/)
    if (option) {
      list.at(-1)?.options.push(option[1].trim())
      continue
    }
    if (/[?？]$/.test(line)) list.push({ question: line, options: [] })
  }
  const result = list.slice(0, 3).map((item) => ({ ...item, options: item.options.slice(0, 4) }))
  return result.length ? result : undefined
}

export function request(
  draft: string,
  history: string,
  input: { answers?: readonly Answer[]; ask?: boolean } = {},
) {
  const context = history
    ? `Recent conversation, for resolving references only:\n<conversation>\n${history}\n</conversation>\n\n`
    : ""
  const answers = input.answers ?? []
  const replies = answers.length
    ? `\n\nThe author answered your clarifying questions. Rewrite now; do not ask again.\n<answers>\n${answers
        .map((item) => `Q: ${item.question}\nA: ${item.answer.trim() || "(no answer, leave it open)"}`)
        .join("\n")}\n</answers>`
    : input.ask === false
      ? "\n\nClarifying questions are not available here. Rewrite now; do not ask."
      : ""
  return `${context}Draft message to rewrite:\n<draft>\n${draft}\n</draft>${replies}`
}

export * as SessionEnhance from "./enhance"
