import type { Message, Part } from "@opencode-ai/sdk/v2/client"

type SDK = {
  client: {
    session: {
      messages: (input: {
        sessionID: string
        limit?: number
        before?: string
      }) => Promise<{ data?: Message[]; error?: unknown }>
    }
    experimental: {
      session: {
        providerRequest: (input: {
          sessionID: string
        }) => Promise<{ data?: ProviderRequestDump; error?: unknown }>
        providerResponse: (input: {
          sessionID: string
        }) => Promise<{ data?: ProviderResponseDump; error?: unknown }>
      }
    }
  }
}

type ProviderRequestDump = {
  sessionID: string
  at: number
  model: string
  provider: string
  route: string
  protocol: string
  url?: string
  body: unknown
  bodyBytes: number
  runtime?: string
}

type ProviderResponseDump = {
  sessionID: string
  at: number
  model: string
  provider: string
  route: string
  protocol: string
  url?: string
  status?: number
  headers?: Record<string, string>
  body: unknown
  bodyBytes: number
  runtime?: string
  error?: boolean
}

function isTextPart(part: Part): part is Extract<Part, { type: "text" }> {
  return part.type === "text"
}

function isReasoningPart(part: Part): part is Extract<Part, { type: "reasoning" }> {
  return part.type === "reasoning"
}

function isToolPart(part: Part): part is Extract<Part, { type: "tool" }> {
  return part.type === "tool"
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString()
}

// 从消息中提取可读文本;tool 调用折叠为单行摘要
function partToText(part: Part): string {
  if (isTextPart(part)) return part.text
  if (isReasoningPart(part)) return `> ${part.text}`
  if (isToolPart(part)) {
    const name = part.tool ?? "tool"
    const state = part.state?.status ?? ""
    return `[${name}] ${state}`.trim()
  }
  if (part.type === "step-start") return ""
  if (part.type === "step-finish") return ""
  return ""
}

function messageToMarkdown(msg: Message): string {
  const role = msg.role === "user" ? "🧑 User" : "🤖 Assistant"
  const time = msg.time?.created ? formatDate(msg.time.created) : ""
  const parts = (msg.parts ?? [])
    .map(partToText)
    .filter((text) => text.trim() !== "")
    .join("\n\n")
  const header = `### ${role}${time ? ` · ${time}` : ""}`
  const summary = msg.role === "user" && msg.summary ? formatSummary(msg.summary) : ""
  return [header, summary, parts].filter(Boolean).join("\n\n")
}

function formatSummary(summary: {
  additions?: number
  deletions?: number
  files?: number
  diffs?: Array<{ file?: string; additions?: number; deletions?: number }>
}): string {
  const lines: string[] = []
  if (summary.additions !== undefined || summary.deletions !== undefined) {
    lines.push(
      `**Changes:** +${summary.additions ?? 0} -${summary.deletions ?? 0} across ${summary.files ?? 0} files`,
    )
  }
  if (summary.diffs && summary.diffs.length > 0) {
    lines.push("")
    lines.push("| File | + | - |")
    lines.push("| --- | --- | --- |")
    for (const diff of summary.diffs) {
      lines.push(`| ${diff.file ?? ""} | +${diff.additions ?? 0} | -${diff.deletions ?? 0} |`)
    }
  }
  return lines.join("\n")
}

// 分页拉取会话的全部消息,按时间正序返回
async function fetchAllMessages(sdk: SDK, sessionID: string): Promise<Message[]> {
  const all: Message[] = []
  let before: string | undefined
  const limit = 200
  while (true) {
    const res = await sdk.client.session.messages({ sessionID, limit, before })
    if (res.error || !res.data) break
    const batch = res.data
    if (batch.length === 0) break
    all.push(...batch)
    if (batch.length < limit) break
    // messages 接口按 time_created/id 倒序返回,before 游标取最后一条 id
    before = batch[batch.length - 1]?.id
    if (!before) break
  }
  // 倒序拉取后翻回正序,便于阅读
  return all.reverse()
}

function download(filename: string, content: string, mime = "text/markdown") {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function safeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 80) || "session"
}

// 摘要导出:可读的 markdown 对话记录,含 user/assistant 文本、reasoning 与 tool 调用摘要
export async function exportSummary(sdk: SDK, sessionID: string, title: string): Promise<void> {
  const messages = await fetchAllMessages(sdk, sessionID)
  const lines: string[] = [`# ${title}`, ""]
  for (const msg of messages) {
    lines.push(messageToMarkdown(msg))
    lines.push("")
  }
  download(`${safeFilename(title)}.md`, lines.join("\n"))
}

// 完整导出:dump 数据库中该会话的全部原始消息记录,含所有 part 的元数据、时间戳与状态
export async function exportFull(sdk: SDK, sessionID: string, title: string): Promise<void> {
  const messages = await fetchAllMessages(sdk, sessionID)
  const dump = {
    sessionID,
    title,
    exportedAt: new Date().toISOString(),
    messageCount: messages.length,
    messages,
  }
  download(`${safeFilename(title)}-raw.json`, JSON.stringify(dump, null, 2), "application/json")
}

// 导出进程内最近一次真实发出的 provider wire request body（与桌面手动 dump 同级）
export async function exportLastRequest(sdk: SDK, sessionID: string): Promise<void> {
  const res = await sdk.client.experimental.session.providerRequest({ sessionID })
  if (res.error || !res.data) throw new Error("No provider request captured for this session")
  const snap = res.data
  const ts = new Date(snap.at).toISOString().replace(/[:.]/g, "-").slice(0, 19)
  const model = snap.model.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
  download(`${ts}_${snap.route}_${model}.json`, JSON.stringify(snap.body, null, 2), "application/json")
}

// 导出进程内最近一次真实收到的 provider wire response body
export async function exportLastResponse(sdk: SDK, sessionID: string): Promise<void> {
  const res = await sdk.client.experimental.session.providerResponse({ sessionID })
  if (res.error || !res.data) throw new Error("No provider response captured for this session")
  const snap = res.data
  const ts = new Date(snap.at).toISOString().replace(/[:.]/g, "-").slice(0, 19)
  const model = snap.model.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
  download(`${ts}_${snap.route}_${model}_response.json`, JSON.stringify(snap.body, null, 2), "application/json")
}