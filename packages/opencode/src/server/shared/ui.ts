import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { createHash } from "node:crypto"
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib"

let embeddedUIPromise: Promise<Record<string, string> | null> | undefined

export const UI_UPSTREAM = new URL("https://app.opencode.ai")

export const csp = (hash = "") =>
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${hash ? ` 'sha256-${hash}'` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src * data:`
export const DEFAULT_CSP = csp()

export function themePreloadHash(body: string) {
  return body.match(/<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(['"])oc-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i)
}

export function cspForHtml(body: string) {
  const match = themePreloadHash(body)
  return csp(match ? createHash("sha256").update(match[2]).digest("base64") : "")
}

function proxyResponseHeaders(headers: Record<string, string>) {
  const result = new Headers(headers)
  // FetchHttpClient exposes decoded response bodies, so forwarding upstream
  // transfer metadata makes browsers decode already-decoded assets again.
  result.delete("content-encoding")
  result.delete("content-length")
  result.delete("transfer-encoding")
  return result
}

export function upstreamURL(path: string) {
  const url = new URL(UI_UPSTREAM)
  // 只替换路径，避免双斜线路径把固定 UI 上游变成任意外部主机。
  url.pathname = path
  return url.toString()
}

export function embeddedUI(disableEmbeddedWebUi: boolean) {
  if (disableEmbeddedWebUi) return Promise.resolve(null)
  return (embeddedUIPromise ??=
    // @ts-expect-error - generated file at build time
    import("opencode-web-ui.gen.ts").then((module) => module.default as Record<string, string>).catch(() => null))
}

function notFound() {
  return HttpServerResponse.jsonUnsafe({ error: "Not Found" }, { status: 404 })
}

const COMPRESSIBLE_UI_TYPE =
  /^(?:text\/|application\/(?:javascript|json|wasm|xml|manifest\+json)|image\/(?:svg\+xml|x-icon|vnd\.microsoft\.icon)|font\/ttf)/i
const COMPRESS_THRESHOLD_BYTES = 1024

// 内嵌 UI 在进程内不会变化：压缩结果与 ETag 按文件缓存，避免每次请求重复压缩数 MB 的主包。
const encodedUICache = new Map<string, Uint8Array>()
const etagUICache = new Map<string, string>()

type UIEncoding = "br" | "gzip"

function pickUIEncoding(acceptEncoding: string | undefined): UIEncoding | undefined {
  const accepted = (acceptEncoding ?? "").toLowerCase()
  if (/(?:^|,)\s*br\s*(?:;|,|$)/.test(accepted)) return "br"
  if (accepted.includes("gzip")) return "gzip"
  return undefined
}

function encodeUI(key: string, body: Uint8Array, encoding: UIEncoding) {
  const cacheKey = `${encoding}:${key}`
  const cached = encodedUICache.get(cacheKey)
  if (cached) return cached
  const encoded =
    encoding === "br"
      ? brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 } })
      : gzipSync(body, { level: 9 })
  encodedUICache.set(cacheKey, encoded)
  return encoded
}

function uiETag(key: string, body: Uint8Array) {
  const cached = etagUICache.get(key)
  if (cached) return cached
  const etag = `"${createHash("sha1").update(body).digest("base64url")}"`
  etagUICache.set(key, etag)
  return etag
}

function embeddedUIResponse(
  file: string,
  body: Uint8Array,
  input: { immutable: boolean; headers: Record<string, string | undefined> },
) {
  const mime = FSUtil.mimeType(file)
  const key = `${file}:${body.byteLength}`
  const etag = uiETag(key, body)
  const headers = new Headers({
    "content-type": mime,
    etag,
    vary: "Accept-Encoding",
    // 带哈希的构建产物永不变化；入口 HTML 与其它文件每次校验，升级后才能立即拿到新入口。
    // 使用 private：响应需要鉴权，只允许浏览器缓存，不交给共享缓存。
    "cache-control": input.immutable ? "private, max-age=31536000, immutable" : "private, no-cache",
  })
  if (mime.startsWith("text/html")) {
    headers.set("content-security-policy", cspForHtml(new TextDecoder().decode(body)))
  }
  if (input.headers["if-none-match"]?.split(",").some((value) => value.trim() === etag)) {
    return HttpServerResponse.empty({ status: 304, headers })
  }
  const encoding = pickUIEncoding(input.headers["accept-encoding"])
  if (encoding && body.byteLength >= COMPRESS_THRESHOLD_BYTES && COMPRESSIBLE_UI_TYPE.test(mime)) {
    headers.set("content-encoding", encoding)
    return HttpServerResponse.raw(encodeUI(key, body, encoding), { headers })
  }
  return HttpServerResponse.raw(body, { headers })
}

export function serveEmbeddedUIEffect(
  requestPath: string,
  fs: FSUtil.Interface,
  embeddedWebUI: Record<string, string>,
  requestHeaders: Record<string, string | undefined> = {},
) {
  const name = requestPath.replace(/^\//, "")
  const matched = embeddedWebUI[name]
  const file = matched ?? embeddedWebUI["index.html"] ?? null
  if (!file) return Effect.succeed(notFound())
  // 只有真实命中的 assets/ 文件才可长期缓存；缺失的旧哈希回落到 index.html，绝不能被永久缓存。
  const immutable = matched !== undefined && name.startsWith("assets/")

  return fs.readFile(file).pipe(
    Effect.map((body) => embeddedUIResponse(file, body, { immutable, headers: requestHeaders })),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(notFound())),
  )
}

export function serveUIEffect(
  request: HttpServerRequest.HttpServerRequest,
  services: { fs: FSUtil.Interface; client: HttpClient.HttpClient; disableEmbeddedWebUi: boolean },
) {
  return Effect.gen(function* () {
    // 未命中的写请求不能把本机 API 请求体发送给外部静态资源服务。
    if (request.method !== "GET" && request.method !== "HEAD") {
      return HttpServerResponse.empty({ status: 405, headers: { allow: "GET, HEAD" } })
    }
    const embeddedWebUI = yield* Effect.promise(() => embeddedUI(services.disableEmbeddedWebUi))
    const path = new URL(request.url, "http://localhost").pathname

    if (embeddedWebUI) return yield* serveEmbeddedUIEffect(path, services.fs, embeddedWebUI, request.headers)

    // UI 上游不属于本机信任域，只转发资源协商头，绝不携带凭据或 Referer。
    const upstreamHeaders = Object.fromEntries(
      ["accept", "accept-language", "if-none-match", "if-modified-since"].flatMap((key) =>
        request.headers[key] === undefined ? [] : [[key, request.headers[key]]],
      ),
    )
    const response = yield* services.client.execute(
      HttpClientRequest.make(request.method)(upstreamURL(path), {
        headers: upstreamHeaders,
      }),
    )
    const headers = proxyResponseHeaders(response.headers)

    if (response.headers["content-type"]?.includes("text/html")) {
      const body = yield* response.text
      headers.set("Content-Security-Policy", cspForHtml(body))
      return HttpServerResponse.text(body, { status: response.status, headers })
    }

    headers.set("Content-Security-Policy", csp())
    return HttpServerResponse.stream(response.stream.pipe(Stream.catchCause(() => Stream.empty)), {
      status: response.status,
      headers,
    })
  })
}
