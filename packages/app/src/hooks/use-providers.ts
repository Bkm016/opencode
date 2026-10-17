import { useServerSync } from "@/context/server-sync"
import { useServerSDK } from "@/context/server-sdk"
import { decode64 } from "@/utils/base64"
import { useParams } from "@solidjs/router"
import { Iterable, pipe } from "effect"
import { createMemo, type Accessor } from "solid-js"
import type { Model, Provider, ProviderConfig } from "@opencode-ai/sdk/v2/client"
import type { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"

export const popularProviders = [
  "opencode",
  "opencode-go",
  "anthropic",
  "github-copilot",
  "openai",
  "google",
  "openrouter",
  "vercel",
]
const popularProviderSet = new Set(popularProviders)

// Built-in OpenAI catalog so the provider appears (and can be connected) even
// when it is not declared in opencode.json. Mirrors the ChatGPT models upstream
// ships in its models.dev catalog; connecting persists the block to config.
const openaiModel = (name: string, context: number): NonNullable<ProviderConfig["models"]>[string] => ({
  name,
  reasoning: true,
  attachment: true,
  tool_call: true,
  temperature: false,
  modalities: { input: ["text", "image"], output: ["text"] },
  limit: { context, output: 128_000 },
  cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  variants: {
    low: { reasoningEffort: "low" },
    medium: { reasoningEffort: "medium" },
    high: { reasoningEffort: "high" },
  },
})

export const openaiProviderPreset: ProviderConfig = {
  name: "OpenAI",
  npm: "@ai-sdk/openai",
  models: {
    "gpt-5.5": openaiModel("GPT-5.5", 400_000),
    "gpt-5.5-fast": openaiModel("GPT-5.5 Fast", 400_000),
    "gpt-5.6-luna": openaiModel("GPT-5.6 Luna", 272_000),
    "gpt-5.6-luna-fast": openaiModel("GPT-5.6 Luna Fast", 272_000),
    "gpt-5.6-sol": openaiModel("GPT-5.6 Sol", 272_000),
    "gpt-5.6-sol-fast": openaiModel("GPT-5.6 Sol Fast", 272_000),
    "gpt-5.6-terra": openaiModel("GPT-5.6 Terra", 272_000),
    "gpt-5.6-terra-fast": openaiModel("GPT-5.6 Terra Fast", 272_000),
    "gpt-6-astra": openaiModel("GPT-6 Astra", 272_000),
    "gpt-6-astra-fast": openaiModel("GPT-6 Astra Fast", 272_000),
    "gpt-6-luna": openaiModel("GPT-6 Luna", 272_000),
    "gpt-6-luna-fast": openaiModel("GPT-6 Luna Fast", 272_000),
    "gpt-6-sol": openaiModel("GPT-6 Sol", 272_000),
    "gpt-6-sol-fast": openaiModel("GPT-6 Sol Fast", 272_000),
    "gpt-6.1-sol": openaiModel("GPT-6.1 Sol", 500_000),
    "gpt-6.1-sol-fast": openaiModel("GPT-6.1 Sol Fast", 500_000),
  },
}

export type OpenAIModelLimit = {
  limit?: { context?: number; output?: number }
  [key: string]: unknown
}

// Fill context windows from the account's real model list. Values that differ
// from the built-in preset are treated as user edits and left untouched.
export function mergeOpenAILimits(
  models: Record<string, OpenAIModelLimit>,
  contexts: Map<string, number>,
): Record<string, OpenAIModelLimit> | undefined {
  const preset = openaiProviderPreset.models ?? {}
  const next = { ...models }
  let changed = false
  for (const [id, model] of Object.entries(next)) {
    const context = contexts.get(id)
    if (!context) continue
    const presetContext = preset[id]?.limit?.context
    // Older builds shipped 400K for gpt-5.5 and 500K for everything else.
    const legacyContext = id.startsWith("gpt-5.5") ? 400_000 : 500_000
    if (model.limit?.context && model.limit.context !== presetContext && model.limit.context !== legacyContext) continue
    if (model.limit?.context === context) continue
    next[id] = {
      ...model,
      limit: { context, output: model.limit?.output ?? 128_000 },
    }
    changed = true
  }
  return changed ? next : undefined
}

// Fetch the account's real context windows and write them into the config for
// models that still carry the built-in preset limit. User-edited limits are
// preserved.
export async function syncOpenAILimits(
  serverSDK: ReturnType<typeof useServerSDK>,
  serverSync: ReturnType<typeof useServerSync>,
) {
  try {
    // The sidecar fetches the account's real /v1/models list; browser CORS and
    // proxy handling are not involved here.
    const res = await serverSDK().client.provider.fetchModels({ providerID: "openai" }, { throwOnError: true })
    const payload = res.data as
      | {
          models?: Array<{
            slug?: string
            id?: string
            context_window?: number
            visibility?: string
            supported_in_api?: boolean
          }>
          data?: Array<{ id?: string; context_window?: number }>
        }
      | undefined
    const rows = (payload?.models ?? payload?.data ?? []) as Array<{
      slug?: string
      id?: string
      context_window?: number
      visibility?: string
      supported_in_api?: boolean
    }>
    const contexts = new Map<string, number>()
    for (const row of rows) {
      const id = row.slug ?? row.id
      if (!id) continue
      if (row.visibility && row.visibility !== "list") continue
      if (row.supported_in_api === false) continue
      if (typeof row.context_window === "number") contexts.set(id, row.context_window)
    }
    if (!contexts.size) return
    const config = serverSync().data.config
    const target = config.provider?.openai
    if (!target?.models) return
    const models = mergeOpenAILimits(target.models as unknown as Record<string, OpenAIModelLimit>, contexts)
    if (!models) return
    await serverSync().updateConfig({
      provider: {
        ...config.provider,
        openai: { ...target, models: models as typeof target.models },
      },
    })
  } catch {
    return
  }
}

const INPUTS = ["text", "image", "audio", "video", "pdf"] as const
type InputKey = (typeof INPUTS)[number]

function toCapabilities(model: {
  modalities?: { input?: string[]; output?: string[] }
  variants?: Record<string, unknown>
}) {
  const input = Object.fromEntries(INPUTS.map((k) => [k, model.modalities?.input?.includes(k) ?? false])) as Record<
    InputKey,
    boolean
  >
  // 默认 text 输入永远可用 — config 里不写 modalities 时保持 text:true
  if (!model.modalities?.input?.length) input.text = true
  const output = Object.fromEntries(INPUTS.map((k) => [k, model.modalities?.output?.includes(k) ?? false])) as Record<
    InputKey,
    boolean
  >
  if (!model.modalities?.output?.length) output.text = true
  return {
    temperature: true,
    reasoning: Boolean(model.variants && Object.keys(model.variants).length > 0),
    attachment: true,
    toolcall: true,
    input,
    output,
    interleaved: false,
  }
}

function toModel(providerID: string, modelID: string, m: Record<string, unknown>): Model {
  const limit = m.limit as { context?: number; input?: number; output?: number } | undefined
  const cost = m.cost as
    | { input?: number; output?: number; cache?: { read?: number; write?: number } }
    | Array<{ input?: number; output?: number; cache?: { read?: number; write?: number } }>
    | undefined
  const flat = Array.isArray(cost) ? cost[0] : cost
  const variants = m.variants as Record<string, Record<string, unknown>> | undefined
  const modalities = m.modalities as { input?: string[]; output?: string[] } | undefined
  const api = m.api as { id?: string; url?: string; npm?: string } | undefined
  return {
    id: modelID,
    providerID,
    api: { id: api?.id ?? modelID, url: api?.url ?? "", npm: api?.npm ?? "" },
    name: (m.name as string) ?? modelID,
    capabilities: toCapabilities({ modalities, variants }),
    cost: {
      input: flat?.input ?? 0,
      output: flat?.output ?? 0,
      cache: { read: flat?.cache?.read ?? 0, write: flat?.cache?.write ?? 0 },
    },
    limit: {
      context: limit?.context ?? 0,
      input: limit?.input,
      output: limit?.output ?? 0,
    },
    status: "active",
    options: {},
    headers: {},
    release_date: "",
    family: (m.family as string) ?? "",
    variants,
  }
}

function toCatalog(config: Record<string, { name?: string; models?: Record<string, Record<string, unknown>> }>) {
  const all = new Map<string, Provider>()
  const connected: string[] = []
  const defaults: Record<string, string> = {}
  for (const [id, p] of Object.entries(config)) {
    const models = Object.fromEntries(
      Object.entries(p.models ?? {}).map(([modelID, m]) => [modelID, toModel(id, modelID, m)]),
    )
    if (Object.keys(models).length === 0) continue
    all.set(id, {
      id,
      name: p.name ?? id,
      source: "config",
      env: [],
      options: {},
      models,
    })
    connected.push(id)
    const first = Object.keys(models)[0]
    if (first) defaults[id] = first
  }
  // Show OpenAI as connectable even without a config block. It is intentionally
  // not marked connected: connecting writes the provider into the config.
  if (!Object.hasOwn(config, "openai")) {
    all.set("openai", {
      id: "openai",
      name: openaiProviderPreset.name ?? "OpenAI",
      source: "config",
      env: [],
      options: {},
      models: Object.fromEntries(
        Object.entries(openaiProviderPreset.models ?? {}).map(([modelID, model]) => [
          modelID,
          toModel("openai", modelID, model),
        ] as const),
      ),
    })
  }
  return { all, connected, default: defaults } satisfies NormalizedProviderListResponse
}

export function useProviders(directory?: Accessor<string | undefined>) {
  const serverSync = useServerSync()
  const params = useParams()
  const dir = () => (directory ? directory() : decode64(params.dir))

  // catalog 完全由 opencode.json 里的 provider.models 构造。
  // 不再调用 provider.list endpoint，也没有 connected 概念 — 配了就可用。
  const catalog = createMemo<NormalizedProviderListResponse>(() => {
    // 优先取目录自己的 config（覆盖工作区级别的 provider 定义），否则用 global config
    const dirConfig = (() => {
      const value = dir()
      if (!value) return
      const projectStore = serverSync().child(value, { passive: true })[0]
      return projectStore.config?.provider
    })()
    const config = dirConfig ?? serverSync().data.config.provider ?? {}
    return toCatalog(config)
  })

  return {
    all: () => catalog().all,
    default: () => catalog().default,
    popular: () =>
      pipe(
        catalog().all,
        Iterable.map(([, p]) => p),
        Iterable.filter((p) => popularProviderSet.has(p.id)),
        (v) => Array.from(v),
      ),
    connected: () =>
      pipe(
        catalog().all,
        Iterable.map(([, p]) => p),
        (v) => Array.from(v),
      ),
    paid: () => Array.from(catalog().all.entries()),
  }
}
