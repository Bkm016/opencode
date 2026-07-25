import type { LLMRequest } from "./schema"
import { sessionIDOf } from "./request-dump"
import { redactSensitiveBodyFields } from "./redact"

export type ProviderResponseSnapshot = {
  readonly sessionID: string
  readonly at: number
  readonly model: string
  readonly provider: string
  readonly route: string
  readonly protocol: string
  readonly url?: string
  readonly status?: number
  readonly headers?: Record<string, string>
  /** 原始 wire 响应：SSE 文本、JSON 对象，或 AI SDK stream parts 数组。 */
  readonly body: unknown
  readonly bodyBytes: number
  readonly runtime?: string
  readonly error?: boolean
}

const bySession = new Map<string, ProviderResponseSnapshot>()
const globalRing: ProviderResponseSnapshot[] = []
const GLOBAL_LIMIT = 5

function parseBody(body: unknown): unknown {
  if (typeof body !== "string") return body
  const trimmed = body.trim()
  if (!trimmed) return body
  // 完整 JSON 响应体可解析；SSE 多事件文本保持原文。
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(body) as unknown
    } catch {
      return body
    }
  }
  return body
}

function bodyBytesOf(body: unknown, explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit)) return explicit
  const text = typeof body === "string" ? body : JSON.stringify(body)
  return new TextEncoder().encode(text).byteLength
}

export type RecordInput = {
  readonly body: unknown
  readonly sessionID?: string
  readonly model?: string
  readonly provider?: string
  readonly route?: string
  readonly protocol?: string
  readonly url?: string
  readonly status?: number
  readonly headers?: Record<string, string>
  readonly bodyBytes?: number
  readonly runtime?: string
  readonly error?: boolean
  readonly request?: LLMRequest
}

/** 记录一次真实收到的 provider response body（进程内 ring buffer，不落库）。 */
export function record(input: RecordInput): ProviderResponseSnapshot | undefined {
  const sessionID = input.sessionID ?? (input.request ? sessionIDOf(input.request) : undefined)
  if (!sessionID) return undefined
  const body = parseBody(input.body)
  const model = input.model ?? input.request?.model.id ?? "unknown"
  const provider = input.provider ?? (input.request ? String(input.request.model.provider) : "unknown")
  const route = input.route ?? input.request?.model.route.id ?? "unknown"
  const protocol = input.protocol ?? input.request?.model.route.protocol ?? "unknown"
  const snapshot: ProviderResponseSnapshot = {
    sessionID,
    at: Date.now(),
    model,
    provider,
    route,
    protocol,
    url: input.url,
    status: input.status,
    headers: input.headers,
    body,
    bodyBytes: bodyBytesOf(body, input.bodyBytes),
    runtime: input.runtime,
    error: input.error,
  }
  bySession.set(sessionID, snapshot)
  globalRing.push(snapshot)
  if (globalRing.length > GLOBAL_LIMIT) globalRing.shift()
  return snapshot
}

export function get(sessionID: string): ProviderResponseSnapshot | undefined {
  return bySession.get(sessionID)
}

export function latest(): ProviderResponseSnapshot | undefined {
  return globalRing[globalRing.length - 1]
}

/** 导出用：文件名友好。 */
export function filename(snapshot: ProviderResponseSnapshot): string {
  const ts = new Date(snapshot.at).toISOString().replace(/[:.]/g, "-").slice(0, 19)
  const model = snapshot.model.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
  return `${ts}_${snapshot.route}_${model}_response.json`
}

/** 可选脱敏后的 JSON 文本（调试分享时用）。 */
export function redactJson(snapshot: ProviderResponseSnapshot): string {
  return redactSensitiveBodyFields(JSON.stringify(snapshot, null, 2))
}

/** 拼接 Uint8Array 流为 UTF-8 文本。 */
export function decodeChunks(chunks: readonly Uint8Array[]): string {
  if (chunks.length === 0) return ""
  if (chunks.length === 1) return new TextDecoder().decode(chunks[0])
  let total = 0
  for (const chunk of chunks) total += chunk.byteLength
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

export * as ProviderResponseDump from "./response-dump"
