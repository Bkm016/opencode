import type { SessionV1 } from "@opencode-ai/core/v1/session"

/**
 * 提示词优化：把用户还没发出去的话改写得更清楚。
 * 价值主要在补上下文（把"那个""刚才"换成具体对象、带上对话里说过的约束），不是润色措辞。
 */

/** 改写时参考的最近消息条数 */
export const RECENT = 12
const MESSAGE_LIMIT = 1500
const TRANSCRIPT_LIMIT = 12_000

export const SYSTEM = `You rewrite a developer's draft message to a coding agent so the agent understands it on the first try.

Rules:
- Keep the author's intent, language, and tone. If the draft is in Chinese, answer in Chinese.
- Make it concrete: replace vague references ("that", "it", "the thing from before") with the specific files, functions, errors, or UI elements they refer to in the conversation.
- Carry over constraints the author already stated in the conversation when they apply to this request.
- If useful, state the goal and how to tell it is done. Keep it short; at most about twice the draft's length.
- Do not add requirements, steps, or preferences the author did not express. Do not guess at missing details.
- Keep @mentions, file paths, code, and placeholders like [Image 1] or [Pasted ~3 lines] exactly as written.
- Do not answer the request, write code, or explain what you changed.
- If the draft is already clear, return it almost unchanged.

Output only the rewritten message.`

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

export function request(draft: string, history: string) {
  const context = history
    ? `Recent conversation, for resolving references only:\n<conversation>\n${history}\n</conversation>\n\n`
    : ""
  return `${context}Draft message to rewrite:\n<draft>\n${draft}\n</draft>`
}

export * as SessionEnhance from "./enhance"
