import { Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import * as McpWebSearch from "./mcp-websearch"

// 与上游 core/src/plugin/websearch 对齐的五个渠道；都支持免 key 调用，配置对应环境变量后带 key
export const PROVIDERS = ["exa", "parallel", "tavily", "tinyfish", "firecrawl"] as const
export type ProviderID = (typeof PROVIDERS)[number]

export const PROVIDER_NAMES: Record<ProviderID, string> = {
  exa: "Exa",
  parallel: "Parallel",
  tavily: "Tavily",
  tinyfish: "TinyFish",
  firecrawl: "Firecrawl",
}

export function isProviderID(value: unknown): value is ProviderID {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value)
}

export type Result = {
  url: string
  title?: string
  content?: string
  /** 发布时间（毫秒） */
  published?: number
}

export type Input = {
  query: string
  numResults: number
  sessionID: string
  modelName?: string
  exa: { type: string; livecrawl: string; contextMaxCharacters?: number }
}

const TIMEOUT = "25 seconds"

const userAgent = () => ({ "User-Agent": `opencode/${InstallationVersion}` })

function time(value: string | null | undefined) {
  if (!value || value === "N/A") return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

const firstText = (result: McpWebSearch.McpResult | undefined) => result?.content.find((item) => item.text)?.text

function decodeJson<A>(schema: Schema.Decoder<A>, text: string | undefined): A | undefined {
  if (!text) return undefined
  try {
    return Option.getOrUndefined(Schema.decodeUnknownOption(schema)(JSON.parse(text)))
  } catch {
    return undefined
  }
}

/** Exa 返回纯文本，按 `---` 分块解析出 Title/URL/Published/Highlights */
export function parseExa(text: string): Result[] {
  return text.split(/\n\n---\n\n/).flatMap((block) => {
    const url = block.match(/^URL:\s*(.+)$/m)?.[1]?.trim()
    if (!url) return []
    const title = block.match(/^Title:\s*(.+)$/m)?.[1]?.trim()
    const content = block.match(/^(?:Highlights|Text):\s*\n?([\s\S]*)$/m)?.[1]?.trim()
    const published = time(block.match(/^Published:\s*(.+)$/m)?.[1]?.trim())
    return [
      {
        url,
        ...(title && title !== "N/A" ? { title } : {}),
        ...(content ? { content } : {}),
        ...(published !== undefined ? { published } : {}),
      },
    ]
  })
}

const ParallelResponse = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      url: Schema.String,
      title: Schema.optional(Schema.NullOr(Schema.String)),
      publish_date: Schema.optional(Schema.NullOr(Schema.String)),
      excerpts: Schema.Array(Schema.String),
    }),
  ),
})

export function parseParallel(result: McpWebSearch.McpResult | undefined): Result[] | undefined {
  const structured = Option.getOrUndefined(Schema.decodeUnknownOption(ParallelResponse)(result?.structuredContent))
  const response = structured ?? decodeJson(ParallelResponse, firstText(result))
  return response?.results.map((item) => ({
    url: item.url,
    ...(item.title ? { title: item.title } : {}),
    ...(item.excerpts.length ? { content: item.excerpts.join("\n\n") } : {}),
    ...(time(item.publish_date) !== undefined ? { published: time(item.publish_date) } : {}),
  }))
}

const FirecrawlResponse = Schema.Struct({
  data: Schema.Struct({
    web: Schema.Array(
      Schema.Struct({
        url: Schema.String,
        title: Schema.optional(Schema.NullOr(Schema.String)),
        description: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  }),
})

export function parseFirecrawl(text: string | undefined): Result[] | undefined {
  return decodeJson(FirecrawlResponse, text)?.data.web.map((item) => ({
    url: item.url,
    ...(item.title ? { title: item.title } : {}),
    ...(item.description ? { content: item.description } : {}),
  }))
}

const TinyFishResponse = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      url: Schema.String,
      title: Schema.optional(Schema.NullOr(Schema.String)),
      snippet: Schema.optional(Schema.NullOr(Schema.String)),
      date: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
})

export function parseTinyFish(text: string | undefined): Result[] | undefined {
  return decodeJson(TinyFishResponse, text)?.results.map((item) => ({
    url: item.url,
    ...(item.title ? { title: item.title } : {}),
    ...(item.snippet ? { content: item.snippet } : {}),
    ...(time(item.date) !== undefined ? { published: time(item.date) } : {}),
  }))
}

const TavilyRequest = Schema.Struct({
  query: Schema.String,
  search_depth: Schema.Literal("basic"),
  chunks_per_source: Schema.Number,
  max_results: Schema.Number,
})

const TavilyResponse = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      url: Schema.String,
      title: Schema.optional(Schema.NullOr(Schema.String)),
      content: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
})

const tavily = (http: HttpClient.HttpClient, input: Input) =>
  Effect.gen(function* () {
    const key = process.env.TAVILY_API_KEY
    const request = yield* HttpClientRequest.post("https://api.tavily.com/search").pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.setHeaders({
        ...userAgent(),
        "X-Client-Name": "opencode",
        ...(key ? { Authorization: `Bearer ${key}` } : { "X-Tavily-Access-Mode": "keyless" }),
      }),
      HttpClientRequest.schemaBodyJson(TavilyRequest)({
        query: input.query,
        search_depth: "basic",
        chunks_per_source: 3,
        max_results: input.numResults,
      }),
    )
    const text = yield* HttpClient.filterStatusOk(http)
      .execute(request)
      .pipe(
        Effect.flatMap((response) => response.text),
        Effect.timeoutOrElse({
          duration: TIMEOUT,
          orElse: () => Effect.fail(new Error("Tavily web search request timed out")),
        }),
      )
    return (decodeJson(TavilyResponse, text)?.results ?? []).map((item) => ({
      url: item.url,
      ...(item.title ? { title: item.title } : {}),
      ...(item.content ? { content: item.content } : {}),
    }))
  })

/**
 * 部分渠道限流/额度用尽时仍返回 HTTP 200，只在正文里给一段说明（如 Firecrawl 的 KEYLESS_QUOTA_EXHAUSTED）；
 * MCP 标记 isError 或结构化结果解析不出来时按失败处理，random 模式才会换渠道
 */
const parsed =
  (parse: (result: McpWebSearch.McpResult) => Result[] | undefined, limit: number) =>
  (result: McpWebSearch.McpResult | undefined) => {
    const text = firstText(result)?.trim()
    const results = result && !result.isError ? parse(result) : undefined
    if (results) return Effect.succeed(results.slice(0, limit))
    if (!text) return Effect.succeed([])
    return Effect.fail(new Error(text.split("\n")[0].slice(0, 200)))
  }

export function search(http: HttpClient.HttpClient, provider: ProviderID, input: Input) {
  switch (provider) {
    case "exa": {
      const url = new URL(McpWebSearch.EXA_URL)
      if (process.env.EXA_API_KEY) url.searchParams.set("exaApiKey", process.env.EXA_API_KEY)
      return McpWebSearch.call(
        http,
        url.toString(),
        "web_search_exa",
        {
          query: input.query,
          type: input.exa.type,
          numResults: input.numResults,
          livecrawl: input.exa.livecrawl,
          ...(input.exa.contextMaxCharacters ? { contextMaxCharacters: input.exa.contextMaxCharacters } : {}),
        },
        TIMEOUT,
      ).pipe(Effect.flatMap(parsed((result) => parseExa(firstText(result) ?? ""), input.numResults)))
    }
    case "parallel": {
      const key = process.env.PARALLEL_API_KEY
      return McpWebSearch.call(
        http,
        McpWebSearch.PARALLEL_URL,
        "web_search",
        {
          objective: input.query,
          search_queries: [input.query],
          session_id: input.sessionID,
          ...(input.modelName ? { model_name: input.modelName } : {}),
        },
        TIMEOUT,
        { ...userAgent(), ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      ).pipe(Effect.flatMap(parsed(parseParallel, input.numResults)))
    }
    case "firecrawl": {
      const key = process.env.FIRECRAWL_API_KEY
      return McpWebSearch.call(
        http,
        McpWebSearch.FIRECRAWL_URL,
        "firecrawl_search",
        { query: input.query, limit: input.numResults },
        TIMEOUT,
        { ...userAgent(), ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      ).pipe(Effect.flatMap(parsed((result) => parseFirecrawl(firstText(result)), input.numResults)))
    }
    case "tinyfish": {
      const key = process.env.TINYFISH_API_KEY
      return McpWebSearch.call(
        http,
        McpWebSearch.TINYFISH_URL,
        "search",
        { query: input.query },
        TIMEOUT,
        { ...userAgent(), ...(key ? { "X-API-Key": key } : { "X-TinyFish-Access-Mode": "keyless" }) },
      ).pipe(Effect.flatMap(parsed((result) => parseTinyFish(firstText(result)), input.numResults)))
    }
    case "tavily":
      return tavily(http, input)
  }
}

/** 与上游一致：每条结果一段 `## [标题](url)`，可带发布时间和摘要 */
export function format(results: readonly Result[]) {
  return results
    .map((result) => {
      const title = result.title ?? result.url
      const published = result.published ? `\nPublished: ${new Date(result.published).toISOString()}` : ""
      return `## [${title}](${result.url})${published}${result.content ? `\n\n${result.content}` : ""}`
    })
    .join("\n\n")
}
