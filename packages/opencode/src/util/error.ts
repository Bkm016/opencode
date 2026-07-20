import { errorMessage } from "@opencode-ai/tui/util/error"
import { isRecord } from "./record"

export * from "@opencode-ai/tui/util/error"

/** 汇总错误及 cause 链，供重试提示和日志展示真实传输原因。 */
export function errorMessageWithCause(error: unknown): string {
  const seen = new Set<unknown>()
  const layers: string[] = []
  let current: unknown = error

  // 迭代而非递归，避免超深 cause 链栈溢出；仍完整保留每一层。
  while (current !== undefined && current !== null) {
    if (typeof current === "object") {
      if (seen.has(current)) {
        layers.push("...")
        break
      }
      seen.add(current)
    }

    layers.push(describeErrorLayer(current))
    const cause = readCause(current)
    if (cause === undefined) break
    current = cause
  }

  if (layers.length === 0) return "unknown error"

  let result = layers[layers.length - 1]!
  for (let i = layers.length - 2; i >= 0; i--) {
    const layer = layers[i]!
    if (!result) {
      result = layer
      continue
    }
    // Bun/Node 有时已把完整 cause 格式化到外层消息中，此时不再重复追加。
    if (layer.includes(result)) {
      result = layer
      continue
    }
    result = `${layer} (cause: ${result})`
  }
  return result
}

function describeErrorLayer(error: unknown): string {
  if (error instanceof Error) {
    return formatNameMessageCode(error.name, error.message, codeOf(error))
  }

  if (isRecord(error)) {
    const name = typeof error.name === "string" ? error.name : undefined
    const message = typeof error.message === "string" ? error.message : undefined
    if (name || message) return formatNameMessageCode(name, message, codeOf(error))
  }

  return errorMessage(error)
}

function formatNameMessageCode(name: string | undefined, message: string | undefined, code: string | undefined) {
  const generic = !name || name === "Error" || name === "TypeError"
  const text = message
    ? generic || message === name || message.startsWith(`${name}:`)
      ? message
      : `${name}: ${message}`
    : name || "Error"
  if (code && !text.includes(code)) return `${text} [${code}]`
  return text
}

function codeOf(error: object) {
  if (!("code" in error)) return undefined
  const code = error.code
  if (typeof code === "string" && code) return code
  if (typeof code === "number" && Number.isFinite(code)) return String(code)
  return undefined
}

function readCause(error: unknown) {
  if (error instanceof Error) return error.cause
  if (isRecord(error) && "cause" in error) return error.cause
  return undefined
}
