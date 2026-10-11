import { Effect, Schema } from "effect"
import { HttpClient, HttpClientError } from "effect/unstable/http"
import * as Tool from "./tool"
import * as Providers from "./websearch-providers"
import DESCRIPTION from "./websearch.txt"
import { checksum } from "@opencode-ai/core/util/encode"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({ description: "Websearch query" }),
  numResults: Schema.optional(Schema.Number).annotate({
    description: "Number of search results to return (default: 8)",
  }),
  livecrawl: Schema.optional(Schema.Literals(["fallback", "preferred"])).annotate({
    description:
      "Live crawl mode - 'fallback': use live crawling as backup if cached content unavailable, 'preferred': prioritize live crawling (default: 'fallback')",
  }),
  type: Schema.optional(Schema.Literals(["auto", "fast", "deep"])).annotate({
    description: "Search type - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search",
  }),
  contextMaxCharacters: Schema.optional(Schema.Number).annotate({
    description: "Maximum characters for context string optimized for LLMs (default: 10000)",
  }),
})

export type WebSearchProvider = Providers.ProviderID
export type WebSearchChoice = WebSearchProvider | "random"
type WebSearchConfig = false | { provider?: WebSearchChoice } | undefined

export const NO_RESULTS = "No search results found. Please try a different query."

/**
 * 渠道选择优先级：OPENCODE_WEBSEARCH_PROVIDER > 配置 websearch.provider > 旧的 Exa/Parallel 开关 > random
 */
export function resolveWebSearchChoice(
  config: WebSearchConfig,
  flags = { exa: false, parallel: false },
): WebSearchChoice {
  const override = process.env.OPENCODE_WEBSEARCH_PROVIDER
  if (override === "random" || Providers.isProviderID(override)) return override
  if (config && config.provider) return config.provider
  if (flags.parallel) return "parallel"
  if (flags.exa) return "exa"
  return "random"
}

// random 模式的进程内状态：每个会话固定一个渠道；渠道失败（限流、超时、5xx 等）后冷却一段时间
const affinity = new Map<string, WebSearchProvider>()
const cooldowns = new Map<WebSearchProvider, number>()

export function resetWebSearchState() {
  affinity.clear()
  cooldowns.clear()
}

/** 为会话选一个可用渠道：沿用上次的；不可用时按会话 ID 稳定地挑一个没冷却、没试过的 */
export function pickWebSearchProvider(sessionID: string, now: number, attempted: ReadonlySet<WebSearchProvider> = new Set()) {
  for (const [id, until] of cooldowns) if (until <= now) cooldowns.delete(id)
  const usable = (id: WebSearchProvider) => !cooldowns.has(id) && !attempted.has(id)
  const current = affinity.get(sessionID)
  if (current && usable(current)) return current
  const available = Providers.PROVIDERS.filter(usable)
  if (available.length === 0) return undefined
  const offset = Number.parseInt(checksum(sessionID) ?? "0", 36) || 0
  const picked = available[(offset + attempted.size) % available.length]
  affinity.set(sessionID, picked)
  return picked
}

function status(error: unknown) {
  return HttpClientError.isHttpClientError(error) ? error.response?.status : undefined
}

/** 429 按 retry-after 冷却，其余失败冷却 60 秒 */
export function cooldownMillis(error: unknown, now: number) {
  if (status(error) !== 429 || !HttpClientError.isHttpClientError(error)) return 60_000
  const value = error.response?.headers["retry-after"]
  if (!value?.trim()) return 60_000
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : 60_000
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - now) : 60_000
}

export function webSearchErrorMessage(provider: WebSearchProvider, error: unknown) {
  const name = Providers.PROVIDER_NAMES[provider]
  const code = status(error)
  if (code === 429) return `${name} web search rate limited (HTTP 429)`
  if (code === 401 || code === 403) return `${name} web search authentication failed (HTTP ${code})`
  if (code !== undefined) return `${name} web search request failed (HTTP ${code})`
  return `${name} web search failed: ${error instanceof Error ? error.message : String(error)}`
}

export function webSearchProviderLabel(provider: unknown) {
  if (Providers.isProviderID(provider)) return `${Providers.PROVIDER_NAMES[provider]} Web Search`
  return "Web Search"
}

export function webSearchModelName(extra: Tool.Context["extra"]) {
  const model = extra?.model
  if (!model || typeof model !== "object") return undefined
  const api = "api" in model && model.api && typeof model.api === "object" ? model.api : undefined
  const apiID = api && "id" in api && typeof api.id === "string" ? api.id : undefined
  const id = "id" in model && typeof model.id === "string" ? model.id : undefined
  return (apiID ?? id)?.slice(0, 100)
}

export const WebSearchTool = Tool.define(
  "websearch",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const flags = yield* RuntimeFlags.Service
    const config = yield* Config.Service

    return {
      get description() {
        return DESCRIPTION.replace("{{year}}", new Date().getFullYear().toString())
      },
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          const choice = resolveWebSearchChoice(cfg.websearch, {
            exa: flags.enableExa,
            parallel: flags.enableParallel,
          })
          const attempted = new Set<WebSearchProvider>()
          let provider =
            choice === "random" ? (pickWebSearchProvider(ctx.sessionID, Date.now()) ?? "exa") : choice
          yield* ctx.metadata({
            title: `${webSearchProviderLabel(provider)} "${params.query}"`,
            metadata: { provider },
          })

          yield* ctx.ask({
            permission: "websearch",
            patterns: [params.query],
            always: ["*"],
            metadata: {
              query: params.query,
              numResults: params.numResults,
              livecrawl: params.livecrawl,
              type: params.type,
              contextMaxCharacters: params.contextMaxCharacters,
              provider: choice,
            },
          })

          const input: Providers.Input = {
            query: params.query,
            numResults: params.numResults || 8,
            sessionID: ctx.sessionID,
            modelName: webSearchModelName(ctx.extra),
            exa: {
              type: params.type || "auto",
              livecrawl: params.livecrawl || "fallback",
              contextMaxCharacters: params.contextMaxCharacters,
            },
          }
          const failed: { provider: WebSearchProvider; error: string }[] = []

          while (true) {
            attempted.add(provider)
            const result = yield* Providers.search(http, provider, input).pipe(Effect.result)
            if (result._tag === "Success") {
              const results = result.success
              const title = webSearchProviderLabel(provider)
              return {
                output: results.length ? Providers.format(results) : NO_RESULTS,
                title: `${title}: ${params.query}`,
                metadata: { provider, results: results.length, ...(failed.length ? { failed } : {}) },
              }
            }
            const message = webSearchErrorMessage(provider, result.failure)
            failed.push({ provider, error: message })
            if (choice !== "random") return yield* Effect.fail(new Error(message))
            const now = Date.now()
            cooldowns.set(provider, now + cooldownMillis(result.failure, now))
            const next = pickWebSearchProvider(ctx.sessionID, now, attempted)
            if (!next) return yield* Effect.fail(new Error(failed.map((item) => item.error).join("; ")))
            provider = next
            yield* ctx.metadata({
              title: `${webSearchProviderLabel(provider)} "${params.query}"`,
              metadata: { provider, failed },
            })
          }
        }).pipe(Effect.orDie),
    }
  }),
)
