import { Duration, Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"

export const EXA_URL = "https://mcp.exa.ai/mcp"
export const PARALLEL_URL = "https://search.parallel.ai/mcp"
export const FIRECRAWL_URL = "https://mcp.firecrawl.dev/v2/mcp"
export const TINYFISH_URL = "https://agent.tinyfish.ai/mcp"

const McpContent = Schema.Array(
  Schema.Struct({
    type: Schema.String,
    text: Schema.optional(Schema.String),
  }),
)

const McpResult = Schema.Struct({
  result: Schema.Struct({
    content: McpContent,
    structuredContent: Schema.optional(Schema.Unknown),
    isError: Schema.optional(Schema.Boolean),
  }),
})
export type McpResult = Schema.Schema.Type<typeof McpResult>["result"]

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(McpResult))

const parsePayload = (payload: string) =>
  Effect.gen(function* () {
    const trimmed = payload.trim()
    if (!trimmed.startsWith("{")) return undefined
    return (yield* decode(trimmed)).result
  })

/** 解析 JSON-RPC 响应（直接 JSON 或 SSE 的 data 帧），返回 result 整体 */
export const parseResult = Effect.fn("McpWebSearch.parseResult")(function* (body: string) {
  const trimmed = body.trim()
  const direct = trimmed ? yield* parsePayload(trimmed) : undefined
  if (direct) return direct

  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const data = yield* parsePayload(line.substring(6))
    if (data) return data
  }
  return undefined
})

/** 只取第一段文本内容 */
export const parseResponse = Effect.fn("McpWebSearch.parseResponse")(function* (body: string) {
  const result = yield* parseResult(body)
  return result?.content.find((item) => item.text)?.text
})

const McpRequest = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Literal(1),
  method: Schema.Literal("tools/call"),
  params: Schema.Struct({
    name: Schema.String,
    arguments: Schema.Record(Schema.String, Schema.Unknown),
  }),
})

export const call = (
  http: HttpClient.HttpClient,
  url: string,
  tool: string,
  args: Record<string, unknown>,
  timeout: Duration.Input,
  headers?: Record<string, string>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.accept("application/json, text/event-stream"),
      HttpClientRequest.setHeaders(headers ?? {}),
      HttpClientRequest.schemaBodyJson(McpRequest)({
        jsonrpc: "2.0" as const,
        id: 1 as const,
        method: "tools/call" as const,
        params: { name: tool, arguments: args },
      }),
    )
    const body = yield* HttpClient.filterStatusOk(http)
      .execute(request)
      .pipe(
        Effect.flatMap((response) => response.text),
        // 超时按失败处理，random 模式才能换下一个渠道
        Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.fail(new Error(`${tool} request timed out`)) }),
      )
    return yield* parseResult(body)
  })
