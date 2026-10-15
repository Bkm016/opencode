/**
 * 下一步建议：一轮结束后预测用户最可能接着说的一句话，填进空输入框，Tab 采纳。
 * 只生成一句，不写进会话历史，也不自动发送。
 */

export const NONE = "NONE"
const MAX_LENGTH = 80

export function request(history: string) {
  return `Conversation so far:\n<conversation>\n${history}\n</conversation>\n\nWhat will the developer most likely say next?`
}

/** 清理模型输出：只取第一行、去掉引号与前缀；无建议、过长或像是在回答问题时返回 undefined */
export function clean(output: string) {
  const first = output
    .trim()
    .split("\n")
    .find((line) => line.trim())
  if (!first) return
  const text = first
    .trim()
    .replace(/^(?:suggestion|next|user|developer|建议|下一步)\s*[:：]\s*/i, "")
    .replace(/^["'“”‘’「『`]+|["'“”‘’」』`]+$/g, "")
    .trim()
  if (!text || text.toUpperCase() === NONE || text.length > MAX_LENGTH) return
  return text
}

export * as SessionSuggest from "./suggest"
