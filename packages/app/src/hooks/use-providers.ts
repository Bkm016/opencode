import { useServerSync } from "@/context/server-sync"
import { decode64 } from "@/utils/base64"
import { useParams } from "@solidjs/router"
import { Iterable, pipe } from "effect"
import { createMemo, type Accessor } from "solid-js"
import type { Model, Provider } from "@opencode-ai/sdk/v2/client"
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
