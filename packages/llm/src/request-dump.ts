import type { LLMRequest } from "./schema"
import { redactSensitiveBodyFields } from "./redact"

export type ProviderRequestSnapshot = {
  readonly sessionID: string
  readonly at: number
  readonly model: string
  readonly provider: string
  readonly route: string
  readonly protocol: string
  readonly url?: string
  readonly body: unknown
  readonly bodyBytes: number
  readonly runtime?: string
}

const bySession = new Map<string, ProviderRequestSnapshot>()
const globalRing: ProviderRequestSnapshot[] = []
const GLOBAL_LIMIT = 5

export function sessionIDOf(request: LLMRequest): string | undefined {
  const meta = request.metadata
  if (meta && typeof meta.sessionID === "string" && meta.sessionID.length > 0) return meta.sessionID
  const openai = request.providerOptions?.openai
  if (openai && typeof openai === "object" && openai !== null) {
    const key = (openai as { promptCacheKey?: unknown }).promptCacheKey
    if (typeof key === "string" && key.length > 0) return key
  }
  if (typeof request.id === "string" && request.id.length > 0) return request.id
  return undefined
}

function parseBody(body: unknown): unknown {
  if (typeof body !== "string") return body
  try {
    return JSON.parse(body) as unknown
  } catch {
    return body
  }
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
  readonly bodyBytes?: number
  readonly runtime?: string
  /** native 路径传入完整 request，自动推导 session/model/route。 */
  readonly request?: LLMRequest
}

/** 记录一次真实发出的 provider request body（进程内 ring buffer，不落库）。 */
export function record(input: RecordInput): ProviderRequestSnapshot | undefined {
  const sessionID = input.sessionID ?? (input.request ? sessionIDOf(input.request) : undefined)
  if (!sessionID) return undefined
  const body = parseBody(input.body)
  const model = input.model ?? input.request?.model.id ?? "unknown"
  const provider = input.provider ?? (input.request ? String(input.request.model.provider) : "unknown")
  const route = input.route ?? input.request?.model.route.id ?? "unknown"
  const protocol = input.protocol ?? input.request?.model.route.protocol ?? "unknown"
  const snapshot: ProviderRequestSnapshot = {
    sessionID,
    at: Date.now(),
    model,
    provider,
    route,
    protocol,
    url: input.url,
    body,
    bodyBytes: bodyBytesOf(body, input.bodyBytes),
    runtime: input.runtime,
  }
  bySession.set(sessionID, snapshot)
  globalRing.push(snapshot)
  if (globalRing.length > GLOBAL_LIMIT) globalRing.shift()
  return snapshot
}

export function get(sessionID: string): ProviderRequestSnapshot | undefined {
  return bySession.get(sessionID)
}

export function latest(): ProviderRequestSnapshot | undefined {
  return globalRing[globalRing.length - 1]
}

/** 导出用：body 原样，文件名友好。 */
export function filename(snapshot: ProviderRequestSnapshot): string {
  const ts = new Date(snapshot.at).toISOString().replace(/[:.]/g, "-").slice(0, 19)
  const model = snapshot.model.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
  return `${ts}_${snapshot.route}_${model}.json`
}

/** 可选脱敏后的 JSON 文本（调试分享时用）。 */
export function redactJson(snapshot: ProviderRequestSnapshot): string {
  return redactSensitiveBodyFields(JSON.stringify(snapshot, null, 2))
}

export * as ProviderRequestDump from "./request-dump"
