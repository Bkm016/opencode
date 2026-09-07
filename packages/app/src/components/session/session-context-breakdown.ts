import type { Message, Part } from "@opencode-ai/sdk/v2/client"

export type SessionContextBreakdownKey = "system" | "user" | "assistant" | "tool" | "other"

export type SessionContextBreakdownDetail =
  | { kind: "text"; tokens: number }
  | { kind: "reasoning"; tokens: number }
  | { kind: "file"; tokens: number; count: number }
  | { kind: "agent"; tokens: number; count: number }
  | { kind: "subtask"; tokens: number; count: number }
  | { kind: "tool"; name: string; tokens: number; count: number }
  | { kind: "messages"; count: number }
  | { kind: "parts"; count: number }
  | { kind: "overhead" }

export type SessionContextBreakdownSegment = {
  key: SessionContextBreakdownKey
  tokens: number
  width: number
  percent: number
  details: SessionContextBreakdownDetail[]
}

export type SessionContextShareFact =
  | { kind: "chars"; value: number }
  | { kind: "messages"; value: number }
  | { kind: "parts"; value: number }
  | { kind: "calls"; value: number }
  | { kind: "input"; tokens: number }
  | { kind: "output"; tokens: number }
  | { kind: "error"; tokens: number }
  | { kind: "preview"; text: string }

/** One row in the always-visible prompt or tool distribution list. */
export type SessionContextShare = {
  id: string
  kind:
    | "system"
    | "agent"
    | "user"
    | "synthetic"
    | "file"
    | "subtask"
    | "assistant"
    | "reasoning"
    | "tool"
    | "overhead"
  /** Tool name, system section key, or empty for role-level rows. */
  name?: string
  tokens: number
  percent: number
  count?: number
  facts: SessionContextShareFact[]
}

export type SessionContextBreakdownResult = {
  segments: SessionContextBreakdownSegment[]
  prompts: SessionContextShare[]
  tools: SessionContextShare[]
}

const PREVIEW_LIMIT = 3

const estimateTokens = (chars: number) => Math.ceil(chars / 4)
const toPercent = (tokens: number, input: number) => (tokens / input) * 100
const toPercentLabel = (tokens: number, input: number) => Math.round(toPercent(tokens, input) * 10) / 10
const scaleTokens = (tokens: number, scale: number) => Math.floor(tokens * scale)

const previewText = (text: string) => {
  return text.trim()
}

const pushPreview = (list: string[], text: string) => {
  if (list.length >= PREVIEW_LIMIT) return
  const preview = previewText(text)
  if (!preview) return
  if (list.includes(preview)) return
  list.push(preview)
}

const toolParts = (part: Extract<Part, { type: "tool" }>) => {
  const rawInput = part.state?.input
  const inputChars =
    rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
      ? Object.keys(rawInput).length * 16
      : 0
  if (part.state?.status === "pending") {
    return { input: inputChars, output: 0, error: 0, total: inputChars + (part.state.raw?.length ?? 0) }
  }
  if (part.state?.status === "completed") {
    const output = part.state.output?.length ?? 0
    return { input: inputChars, output, error: 0, total: inputChars + output }
  }
  if (part.state?.status === "error") {
    const error = part.state.error?.length ?? 0
    return { input: inputChars, output: 0, error, total: inputChars + error }
  }
  return { input: inputChars, output: 0, error: 0, total: inputChars }
}

type ContentAcc = {
  chars: number
  parts: number
  messages: Set<string>
  previews: string[]
}

type ToolAcc = {
  chars: number
  input: number
  output: number
  error: number
  count: number
  previews: string[]
}

type Bucket = {
  chars: number
  messages: number
  parts: number
  text: ContentAcc
  synthetic: ContentAcc
  reasoning: ContentAcc
  file: ContentAcc
  agent: ContentAcc
  subtask: ContentAcc
  tools: Map<string, ToolAcc>
}

const emptyContent = (): ContentAcc => ({
  chars: 0,
  parts: 0,
  messages: new Set(),
  previews: [],
})

const emptyBucket = (): Bucket => ({
  chars: 0,
  messages: 0,
  parts: 0,
  text: emptyContent(),
  synthetic: emptyContent(),
  reasoning: emptyContent(),
  file: emptyContent(),
  agent: emptyContent(),
  subtask: emptyContent(),
  tools: new Map(),
})

const addContent = (acc: ContentAcc, messageID: string, chars: number, preview?: string) => {
  if (chars <= 0 && !preview) return
  acc.chars += chars
  acc.parts += 1
  acc.messages.add(messageID)
  if (preview) pushPreview(acc.previews, preview)
}

const addUserPart = (bucket: Bucket, messageID: string, part: Part) => {
  bucket.parts += 1
  if (part.type === "text") {
    if (part.synthetic) {
      addContent(bucket.synthetic, messageID, part.text.length, part.text)
      bucket.chars += part.text.length
      return
    }
    addContent(bucket.text, messageID, part.text.length, part.text)
    bucket.chars += part.text.length
    return
  }
  if (part.type === "file") {
    const chars = part.source?.text.value.length ?? 0
    const source = part.source
    const sourceLabel =
      source && "path" in source ? source.path : source && source.type === "resource" ? source.uri : undefined
    const label = part.filename || sourceLabel || part.url || "file"
    addContent(bucket.file, messageID, chars, typeof label === "string" ? label : "file")
    bucket.chars += chars
    return
  }
  if (part.type === "agent") {
    const chars = part.source?.value.length ?? 0
    addContent(bucket.agent, messageID, chars, part.name || part.source?.value)
    bucket.chars += chars
    return
  }
  if (part.type === "subtask") {
    const chars = part.prompt.length + part.description.length
    addContent(bucket.subtask, messageID, chars, part.description || part.prompt)
    bucket.chars += chars
  }
}

const addAssistantPart = (assistant: Bucket, tool: Bucket, messageID: string, part: Part) => {
  if (part.type === "text") {
    assistant.parts += 1
    addContent(assistant.text, messageID, part.text.length, part.text)
    assistant.chars += part.text.length
    return
  }
  if (part.type === "reasoning") {
    assistant.parts += 1
    addContent(assistant.reasoning, messageID, part.text.length, part.text)
    assistant.chars += part.text.length
    return
  }
  if (part.type !== "tool") return

  tool.parts += 1
  const sizes = toolParts(part)
  tool.chars += sizes.total
  const current = tool.tools.get(part.tool) ?? {
    chars: 0,
    input: 0,
    output: 0,
    error: 0,
    count: 0,
    previews: [],
  }
  current.chars += sizes.total
  current.input += sizes.input
  current.output += sizes.output
  current.error += sizes.error
  current.count += 1
  if (part.state?.status === "completed" && part.state.output) pushPreview(current.previews, part.state.output)
  if (part.state?.status === "error" && part.state.error) pushPreview(current.previews, part.state.error)
  if (part.state?.status === "pending" && part.state.raw) pushPreview(current.previews, part.state.raw)
  tool.tools.set(part.tool, current)
}

// 服务端 systemPrompt 预览按装配部分返回数组（内置模板 / env+references / 每条 Instructions from / MCP / 技能 / todo）。
// 这里按部分分块并从文本里识别来源标签，让分布列表与详情弹窗能逐块展开而不是一整块平铺。
const systemSectionName = (block: string) => {
  if (block.startsWith("Instructions from:")) {
    const source = block.slice("Instructions from:".length).split("\n", 1)[0]?.trim() ?? ""
    const name = source.split(/[\\/]/).filter(Boolean).pop()
    if (name) return { kind: "instruction" as const, name }
  }
  if (block.startsWith("<todo-list>")) return { kind: "todo" as const }
  if (block.startsWith("<mcp_instructions>")) return { kind: "mcp" as const }
  if (block.startsWith("Skills provide specialized instructions")) return { kind: "skills" as const }
  if (block.startsWith("Here is some useful information about the environment")) return { kind: "env" as const }
  if (block.startsWith("Project references provide additional")) return { kind: "references" as const }
  return { kind: "base" as const }
}

const systemPromptSections = (prompts: string[]) => {
  const blocks = prompts.map((block) => block.trim()).filter(Boolean)
  if (blocks.length === 0) return [] as { key: string; chars: number; preview: string }[]
  const counts = new Map<string, number>()
  return blocks.map((text, index) => {
    const base = systemSectionName(text)
    const key = base.kind === "instruction" ? `instruction:${base.name}` : base.kind
    const seen = counts.get(key) ?? 0
    counts.set(key, seen + 1)
    // 同类部分出现多次时追加序号，保证行 id 唯一
    const suffix = seen === 0 ? "" : ` ${seen + 1}`
    return { key: `${key}${suffix}`, chars: text.length, preview: previewText(text) }
  })
}

const factsFromContent = (acc: ContentAcc, scale: number): SessionContextShareFact[] => {
  const facts: SessionContextShareFact[] = []
  if (acc.chars > 0) facts.push({ kind: "chars", value: acc.chars })
  if (acc.messages.size > 0) facts.push({ kind: "messages", value: acc.messages.size })
  if (acc.parts > 0) facts.push({ kind: "parts", value: acc.parts })
  for (const text of acc.previews) facts.push({ kind: "preview", text })
  // scale only affects tokens, not raw chars/counts
  void scale
  return facts
}

const rankedTools = (tools: Map<string, ToolAcc>, scale: number, limit?: number) => {
  const rows = [...tools.entries()]
    .map(([name, value]) => ({
      kind: "tool" as const,
      name,
      tokens: scaleTokens(estimateTokens(value.chars), scale),
      count: value.count,
      value,
    }))
    .filter((item) => item.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens || b.count - a.count || a.name.localeCompare(b.name))
  if (limit === undefined) return rows
  return rows.slice(0, limit)
}

const detailsFor = (
  key: SessionContextBreakdownKey,
  bucket: Bucket | undefined,
  tokens: number,
  scale: number,
): SessionContextBreakdownDetail[] => {
  if (key === "other") return tokens > 0 ? [{ kind: "overhead" }] : []
  if (key === "system") {
    const details: SessionContextBreakdownDetail[] = []
    if (tokens > 0) details.push({ kind: "text", tokens })
    if (bucket?.messages) details.push({ kind: "messages", count: bucket.messages })
    return details
  }
  if (!bucket || tokens <= 0) return []

  const details: SessionContextBreakdownDetail[] = []
  const text = scaleTokens(estimateTokens(bucket.text.chars), scale)
  const synthetic = scaleTokens(estimateTokens(bucket.synthetic.chars), scale)
  const reasoning = scaleTokens(estimateTokens(bucket.reasoning.chars), scale)
  const file = scaleTokens(estimateTokens(bucket.file.chars), scale)
  const agent = scaleTokens(estimateTokens(bucket.agent.chars), scale)
  const subtask = scaleTokens(estimateTokens(bucket.subtask.chars), scale)

  if (text > 0) details.push({ kind: "text", tokens: text })
  if (synthetic > 0) details.push({ kind: "text", tokens: synthetic })
  if (reasoning > 0) details.push({ kind: "reasoning", tokens: reasoning })
  if (file > 0) details.push({ kind: "file", tokens: file, count: bucket.file.parts })
  if (agent > 0) details.push({ kind: "agent", tokens: agent, count: bucket.agent.parts })
  if (subtask > 0) details.push({ kind: "subtask", tokens: subtask, count: bucket.subtask.parts })
  if (key === "tool") {
    details.push(
      ...rankedTools(bucket.tools, scale, 8).map((item) => ({
        kind: "tool" as const,
        name: item.name,
        tokens: item.tokens,
        count: item.count,
      })),
    )
  }
  if (bucket.messages > 0) details.push({ kind: "messages", count: bucket.messages })
  if (bucket.parts > 0) details.push({ kind: "parts", count: bucket.parts })
  return details
}

const share = (
  id: string,
  kind: SessionContextShare["kind"],
  tokens: number,
  input: number,
  extra?: { name?: string; count?: number; facts?: SessionContextShareFact[] },
): SessionContextShare | undefined => {
  if (tokens <= 0) return
  return {
    id,
    kind,
    tokens,
    percent: toPercentLabel(tokens, input),
    facts: extra?.facts ?? [],
    ...(extra?.name ? { name: extra.name } : {}),
    ...(extra?.count !== undefined ? { count: extra.count } : {}),
  }
}

const buildPrompts = (
  systemSections: { key: string; chars: number; preview: string }[],
  user: Bucket,
  assistant: Bucket,
  input: number,
  scale: number,
) => {
  const rows: SessionContextShare[] = []
  for (const section of systemSections) {
    const tokens = scaleTokens(estimateTokens(section.chars), scale)
    const facts: SessionContextShareFact[] = [
      { kind: "chars", value: section.chars },
      ...(section.preview ? [{ kind: "preview" as const, text: section.preview }] : []),
    ]
    const row = share(`system:${section.key}`, "system", tokens, input, { name: section.key, facts })
    if (row) rows.push(row)
  }

  const push = (id: string, kind: SessionContextShare["kind"], acc: ContentAcc, count?: number) => {
    const tokens = scaleTokens(estimateTokens(acc.chars), scale)
    const row = share(id, kind, tokens, input, {
      count: count ?? (acc.parts > 0 ? acc.parts : undefined),
      facts: factsFromContent(acc, scale),
    })
    if (row) rows.push(row)
  }

  push("user:text", "user", user.text)
  push("user:synthetic", "synthetic", user.synthetic)
  push("user:file", "file", user.file, user.file.parts)
  push("user:agent", "agent", user.agent, user.agent.parts)
  push("user:subtask", "subtask", user.subtask, user.subtask.parts)
  push("assistant:text", "assistant", assistant.text)
  push("assistant:reasoning", "reasoning", assistant.reasoning)

  return rows.sort((a, b) => b.tokens - a.tokens || a.id.localeCompare(b.id))
}

const buildTools = (tools: Map<string, ToolAcc>, input: number, scale: number) => {
  return rankedTools(tools, scale).map((item) => {
    const facts: SessionContextShareFact[] = [
      { kind: "calls", value: item.count },
      { kind: "chars", value: item.value.chars },
    ]
    const inputTokens = scaleTokens(estimateTokens(item.value.input), scale)
    const outputTokens = scaleTokens(estimateTokens(item.value.output), scale)
    const errorTokens = scaleTokens(estimateTokens(item.value.error), scale)
    if (inputTokens > 0) facts.push({ kind: "input", tokens: inputTokens })
    if (outputTokens > 0) facts.push({ kind: "output", tokens: outputTokens })
    if (errorTokens > 0) facts.push({ kind: "error", tokens: errorTokens })
    for (const text of item.value.previews) facts.push({ kind: "preview", text })
    return {
      id: `tool:${item.name}`,
      kind: "tool" as const,
      name: item.name,
      tokens: item.tokens,
      percent: toPercentLabel(item.tokens, input),
      count: item.count,
      facts,
    }
  })
}

const buildSegments = (
  tokens: { system: number; user: number; assistant: number; tool: number; other: number },
  buckets: { system?: Bucket; user: Bucket; assistant: Bucket; tool: Bucket },
  input: number,
  scale = 1,
) => {
  return (
    [
      { key: "system" as const, tokens: tokens.system, bucket: buckets.system },
      { key: "user" as const, tokens: tokens.user, bucket: buckets.user },
      { key: "assistant" as const, tokens: tokens.assistant, bucket: buckets.assistant },
      { key: "tool" as const, tokens: tokens.tool, bucket: buckets.tool },
      { key: "other" as const, tokens: tokens.other, bucket: undefined },
    ] as const
  )
    .filter((x) => x.tokens > 0)
    .map((x) => ({
      key: x.key,
      tokens: x.tokens,
      width: toPercent(x.tokens, input),
      percent: toPercentLabel(x.tokens, input),
      details: detailsFor(x.key, x.bucket, x.tokens, scale),
    })) as SessionContextBreakdownSegment[]
}

export function estimateSessionContextBreakdown(args: {
  messages: Message[]
  parts: Record<string, Part[] | undefined>
  /** 用作拆分总量的完整输入上下文：input + cache.read + cache.write。 */
  input: number
  systemPrompts?: string[]
  /**
   * 指定后在该 assistant 消息前停止；该消息自身及后续消息不属于它的 provider 请求。
   */
  boundaryMessageID?: string
}): SessionContextBreakdownResult {
  if (!args.input) return { segments: [], prompts: [], tools: [] }

  const user = emptyBucket()
  const assistant = emptyBucket()
  const tool = emptyBucket()
  const system = emptyBucket()
  const systemSections = systemPromptSections(args.systemPrompts ?? [])
  system.chars = systemSections.reduce((sum, section) => sum + section.chars, 0)
  if (system.chars > 0) system.messages = Math.max(1, systemSections.length)

  for (const msg of args.messages) {
    // 当前 assistant 的输出不属于自身请求，但它前面的父级用户消息必须保留。
    if (args.boundaryMessageID !== undefined && msg.id === args.boundaryMessageID) break
    const parts = args.parts[msg.id] ?? []
    if (msg.role === "user") {
      user.messages += 1
      for (const part of parts) addUserPart(user, msg.id, part)
      continue
    }
    if (msg.role !== "assistant") continue
    assistant.messages += 1
    for (const part of parts) addAssistantPart(assistant, tool, msg.id, part)
  }

  const raw = {
    system: estimateTokens(system.chars),
    user: estimateTokens(user.chars),
    assistant: estimateTokens(assistant.chars),
    tool: estimateTokens(tool.chars),
  }
  const estimated = raw.system + raw.user + raw.assistant + raw.tool
  const buckets = { system, user, assistant, tool }

  if (estimated <= args.input) {
    const tokens = { ...raw, other: args.input - estimated }
    return {
      segments: buildSegments(tokens, buckets, args.input),
      prompts: buildPrompts(systemSections, user, assistant, args.input, 1),
      tools: buildTools(tool.tools, args.input, 1),
    }
  }

  const scale = args.input / estimated
  const scaled = {
    system: scaleTokens(raw.system, scale),
    user: scaleTokens(raw.user, scale),
    assistant: scaleTokens(raw.assistant, scale),
    tool: scaleTokens(raw.tool, scale),
  }
  const total = scaled.system + scaled.user + scaled.assistant + scaled.tool
  const tokens = { ...scaled, other: Math.max(0, args.input - total) }
  return {
    segments: buildSegments(tokens, buckets, args.input, scale),
    prompts: buildPrompts(systemSections, user, assistant, args.input, scale),
    tools: buildTools(tool.tools, args.input, scale),
  }
}
