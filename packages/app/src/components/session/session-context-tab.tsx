import { createMemo, createEffect, createResource, createSignal, on, onCleanup, For, Show } from "solid-js"
import type { JSX } from "solid-js"
import { useSync } from "@/context/sync"
import { findLast } from "@opencode-ai/core/util/array"
import { same } from "@/utils/same"
import { Icon } from "@opencode-ai/ui/icon"
import { Button } from "@opencode-ai/ui/button"
import { Accordion } from "@opencode-ai/ui/accordion"
import { StickyAccordionHeader } from "@opencode-ai/ui/sticky-accordion-header"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import type { Message, Part, UserMessage } from "@opencode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { useSDK } from "@/context/sdk"
import { useSessionLayout } from "@/pages/session/session-layout"
import { getSessionContext } from "./session-context-metrics"
import {
  estimateSessionContextBreakdown,
  type SessionContextBreakdownDetail,
  type SessionContextBreakdownKey,
  type SessionContextBreakdownSegment,
  type SessionContextShare,
  type SessionContextShareFact,
} from "./session-context-breakdown"
import { createSessionContextFormatter } from "./session-context-format"

const BREAKDOWN_COLOR: Record<SessionContextBreakdownKey, string> = {
  system: "var(--syntax-info)",
  user: "var(--syntax-success)",
  assistant: "var(--syntax-property)",
  tool: "var(--syntax-warning)",
  other: "var(--syntax-comment)",
}

const SHARE_COLOR: Record<SessionContextShare["kind"], string> = {
  system: "var(--syntax-info)",
  agent: "var(--syntax-keyword)",
  user: "var(--syntax-success)",
  synthetic: "var(--syntax-string)",
  file: "var(--syntax-constant)",
  subtask: "var(--syntax-function)",
  assistant: "var(--syntax-property)",
  reasoning: "var(--syntax-comment)",
  tool: "var(--syntax-warning)",
  overhead: "var(--syntax-comment)",
}

const ROLE_COLOR = {
  user: "var(--syntax-success)",
  assistant: "var(--syntax-property)",
} as const

const PREVIEW_MAX = 100

function breakdownDetailLabel(
  detail: SessionContextBreakdownDetail,
  t: (key: string, vars?: Record<string, string>) => string,
  number: (value: number) => string,
) {
  if (detail.kind === "text") return t("context.breakdown.detail.text", { tokens: number(detail.tokens) })
  if (detail.kind === "reasoning") return t("context.breakdown.detail.reasoning", { tokens: number(detail.tokens) })
  if (detail.kind === "file") {
    return t("context.breakdown.detail.file", { tokens: number(detail.tokens), count: number(detail.count) })
  }
  if (detail.kind === "agent") {
    return t("context.breakdown.detail.agent", { tokens: number(detail.tokens), count: number(detail.count) })
  }
  if (detail.kind === "subtask") {
    return t("context.breakdown.detail.subtask", { tokens: number(detail.tokens), count: number(detail.count) })
  }
  if (detail.kind === "tool") {
    return t("context.breakdown.detail.tool", {
      name: detail.name,
      tokens: number(detail.tokens),
      count: number(detail.count),
    })
  }
  if (detail.kind === "messages") return t("context.breakdown.detail.messages", { count: number(detail.count) })
  if (detail.kind === "parts") return t("context.breakdown.detail.parts", { count: number(detail.count) })
  return t("context.breakdown.detail.overhead")
}

function BreakdownTooltip(props: {
  segment: SessionContextBreakdownSegment
  label: string
  number: (value: number) => string
  t: (key: string, vars?: Record<string, string>) => string
  children: JSX.Element
  class?: string
}) {
  return (
    <Tooltip
      placement="top"
      gutter={8}
      openDelay={200}
      class={props.class}
      contentClass="max-w-72"
      value={
        <div class="flex flex-col gap-1.5 text-left">
          <div class="text-12-medium text-text-strong">{props.label}</div>
          <div class="text-11-regular text-text-weak">
            {props.t("context.breakdown.tooltip.tokens", {
              tokens: props.number(props.segment.tokens),
              percent: props.segment.percent.toLocaleString(),
            })}
          </div>
          <Show when={props.segment.details.length > 0}>
            <div class="flex flex-col gap-0.5 pt-0.5 border-t border-border-weak-base">
              <For each={props.segment.details}>
                {(detail) => (
                  <div class="text-11-regular text-text-weak">
                    {breakdownDetailLabel(detail, props.t, props.number)}
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      }
    >
      {props.children}
    </Tooltip>
  )
}

function shareLabel(
  row: SessionContextShare,
  t: (key: string, vars?: Record<string, string>) => string,
) {
  if (row.kind === "system") return t("context.breakdown.system")
  if (row.kind === "tool") return row.name ?? "tool"
  if (row.kind === "agent") return t("context.breakdown.share.agent")
  if (row.kind === "user") return t("context.breakdown.share.user")
  if (row.kind === "synthetic") return t("context.breakdown.share.synthetic")
  if (row.kind === "file") return t("context.breakdown.share.file")
  if (row.kind === "subtask") return t("context.breakdown.share.subtask")
  if (row.kind === "assistant") return t("context.breakdown.share.assistant")
  if (row.kind === "reasoning") return t("context.breakdown.share.reasoning")
  return t("context.breakdown.share.overhead")
}

function shareFactLabel(
  fact: SessionContextShareFact,
  t: (key: string, vars?: Record<string, string>) => string,
  number: (value: number) => string,
) {
  if (fact.kind === "chars") return t("context.breakdown.share.fact.chars", { value: number(fact.value) })
  if (fact.kind === "messages") return t("context.breakdown.share.fact.messages", { value: number(fact.value) })
  if (fact.kind === "parts") return t("context.breakdown.share.fact.parts", { value: number(fact.value) })
  if (fact.kind === "calls") return t("context.breakdown.share.fact.calls", { value: number(fact.value) })
  if (fact.kind === "input") return t("context.breakdown.share.fact.input", { tokens: number(fact.tokens) })
  if (fact.kind === "output") return t("context.breakdown.share.fact.output", { tokens: number(fact.tokens) })
  if (fact.kind === "error") return t("context.breakdown.share.fact.error", { tokens: number(fact.tokens) })
  return t("context.breakdown.share.fact.preview", { text: fact.text })
}

function ShareDetailDialog(props: {
  row: SessionContextShare
  number: (value: number) => string
  t: (key: string, vars?: Record<string, string>) => string
  intl: string
}) {
  const label = shareLabel(props.row, props.t)
  const meta = () => props.row.facts.filter((fact) => fact.kind !== "preview")
  const previews = () => props.row.facts.filter((fact) => fact.kind === "preview")

  return (
    <Dialog
      title={label}
      description={props.t("context.breakdown.tooltip.tokens", {
        tokens: props.number(props.row.tokens),
        percent: props.row.percent.toLocaleString(props.intl),
      })}
      size="large"
      class="!overflow-hidden h-[min(70vh,32rem)] min-h-0"
    >
      <div class="flex flex-col gap-4 px-4 pb-4 min-w-0 min-h-0 h-full overflow-hidden">
        <div class="flex items-center gap-2 min-w-0 shrink-0">
          <div class="size-2.5 shrink-0 rounded-sm" style={{ "background-color": SHARE_COLOR[props.row.kind] }} />
          <div class="min-w-0 flex-1 text-12-regular text-text-strong truncate">{label}</div>
          <Show when={props.row.count !== undefined}>
            <div class="text-11-regular text-text-weaker tabular-nums shrink-0">
              {props.t("context.breakdown.share.count", { count: props.number(props.row.count ?? 0) })}
            </div>
          </Show>
          <div class="w-12 @[20rem]:w-24 h-1.5 rounded-full bg-surface-raised-base overflow-hidden shrink-0">
            <div
              class="h-full rounded-full"
              style={{
                width: `${Math.min(100, Math.max(props.row.percent, props.row.tokens > 0 ? 2 : 0))}%`,
                "background-color": SHARE_COLOR[props.row.kind],
              }}
            />
          </div>
        </div>

        <Show when={meta().length > 0}>
          <div class="flex flex-col gap-1.5 shrink-0">
            <div class="flex flex-wrap gap-x-3 gap-y-1 text-12-regular text-text-weak">
              <For each={meta()}>{(fact) => <span>{shareFactLabel(fact, props.t, props.number)}</span>}</For>
            </div>
          </div>
        </Show>

        <Show when={previews().length > 0}>
          <div class="flex-1 min-h-0 min-w-0 overflow-hidden rounded-md border border-border-weak-base bg-background-base">
            <ScrollView class="h-full min-w-0">
              <For each={previews()}>
                {(fact) => (
                  <div class="min-w-0 px-3 py-2 border-b border-border-weak-base last:border-b-0">
                    <Markdown
                      text={fact.kind === "preview" ? fact.text : shareFactLabel(fact, props.t, props.number)}
                      class="text-12-regular min-w-0 pl-3 pr-1 break-words [&_p]:whitespace-pre-wrap [&_li]:whitespace-pre-wrap [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_code]:break-words"
                    />
                  </div>
                )}
              </For>
            </ScrollView>
          </div>
        </Show>
      </div>
    </Dialog>
  )
}

function ShareList(props: {
  title: string
  empty: string
  rows: SessionContextShare[]
  number: (value: number) => string
  t: (key: string, vars?: Record<string, string>) => string
  intl: string
}) {
  const dialog = useDialog()

  const openRow = (row: SessionContextShare) => {
    dialog.show(() => (
      <ShareDetailDialog row={row} number={props.number} t={props.t} intl={props.intl} />
    ))
  }

  return (
    <div class="flex flex-col gap-2 min-w-0">
      <div class="text-12-regular text-text-weak">{props.title}</div>
      <Show
        when={props.rows.length > 0}
        fallback={<div class="text-11-regular text-text-weaker">{props.empty}</div>}
      >
        <div class="border border-border-base rounded-md bg-background-base divide-y divide-border-weak-base overflow-hidden min-w-0">
          <For each={props.rows}>
            {(row) => {
              const label = shareLabel(row, props.t)
              return (
                <div
                  role="button"
                  tabIndex={0}
                  class="flex items-center gap-1.5 @[20rem]:gap-2 min-w-0 px-2 @[20rem]:px-3 py-2 cursor-pointer hover:bg-surface-raised-base focus-visible:outline-none focus-visible:bg-surface-raised-base"
                  onClick={() => openRow(row)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return
                    event.preventDefault()
                    openRow(row)
                  }}
                >
                  <div class="size-2 shrink-0 rounded-sm" style={{ "background-color": SHARE_COLOR[row.kind] }} />
                  <div class="min-w-0 flex-1 text-12-regular text-text-strong truncate">{label}</div>
                  <Show when={row.count !== undefined}>
                    <div class="hidden @[18rem]:block text-11-regular text-text-weaker tabular-nums shrink-0">
                      {props.t("context.breakdown.share.count", { count: props.number(row.count ?? 0) })}
                    </div>
                  </Show>
                  <div class="text-11-regular text-text-weak tabular-nums shrink-0 whitespace-nowrap">
                    {props.number(row.tokens)}
                    <span class="hidden @[16rem]:inline"> · {row.percent.toLocaleString(props.intl)}%</span>
                  </div>
                  <div class="hidden @[18rem]:block w-10 @[24rem]:w-16 h-1 rounded-full bg-surface-raised-base overflow-hidden shrink-0">
                    <div
                      class="h-full rounded-full"
                      style={{
                        width: `${Math.min(100, Math.max(row.percent, row.tokens > 0 ? 2 : 0))}%`,
                        "background-color": SHARE_COLOR[row.kind],
                      }}
                    />
                  </div>
                </div>
              )
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}

function StatRow(props: { label: string; value: JSX.Element }) {
  return (
    <div class="flex items-baseline justify-between gap-3 min-w-0">
      <div class="shrink-0 text-11-regular text-text-weaker">{props.label}</div>
      <div class="min-w-0 truncate text-12-medium text-text-strong text-right">{props.value}</div>
    </div>
  )
}

function StatSection(props: { title: string; children: JSX.Element }) {
  return (
    <div class="flex flex-col gap-1.5 min-w-0">
      <div class="text-11-medium text-text-weak">{props.title}</div>
      <div class="flex flex-col gap-1 min-w-0">{props.children}</div>
    </div>
  )
}

function shortMessageId(id: string) {
  if (id.length <= 10) return id
  return id.slice(-8)
}

function collapsePreview(text: string) {
  const collapsed = text.replace(/\s+/g, " ").trim()
  if (!collapsed) return ""
  if (collapsed.length <= PREVIEW_MAX) return collapsed
  return `${collapsed.slice(0, PREVIEW_MAX - 1)}…`
}

function rawMessagePreview(parts: Part[], empty: string, partsCount: (count: number) => string) {
  for (const part of parts) {
    if (part.type === "text" && !part.synthetic) {
      const preview = collapsePreview(part.text)
      if (preview) return preview
    }
    if (part.type === "reasoning") {
      const preview = collapsePreview(part.text)
      if (preview) return preview
    }
    if (part.type === "subtask") {
      const preview = collapsePreview(part.description || part.prompt)
      if (preview) return preview
    }
  }

  const tools = parts.flatMap((part) => (part.type === "tool" ? [part.tool] : []))
  if (tools.length > 0) {
    const unique = [...new Set(tools)]
    return collapsePreview(unique.join(", ")) || empty
  }

  const files = parts.filter((part) => part.type === "file").length
  if (files > 0) return partsCount(parts.length)

  if (parts.length === 0) return empty
  return partsCount(parts.length)
}

function RawMessageContent(props: {
  message: Message
  getParts: (id: string) => Part[]
  copyLabel: string
  copiedLabel: string
}) {
  const language = useLanguage()
  const [copied, setCopied] = createSignal(false)
  let copiedTimer: ReturnType<typeof setTimeout> | undefined

  const json = createMemo(() => {
    const parts = props.getParts(props.message.id)
    return JSON.stringify({ message: props.message, parts }, null, 2)
  })

  const copy = () => {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
    if (!clipboard?.writeText) return
    void clipboard.writeText(json()).then(() => {
      setCopied(true)
      if (copiedTimer !== undefined) clearTimeout(copiedTimer)
      copiedTimer = setTimeout(() => setCopied(false), 1500)
    })
  }

  onCleanup(() => {
    if (copiedTimer === undefined) return
    clearTimeout(copiedTimer)
  })

  const parts = createMemo(() => props.getParts(props.message.id))
  const summary = createMemo(() => {
    const list = parts()
    const tools = list.reduce((count, part) => count + (part.type === "tool" ? 1 : 0), 0)
    const texts = list.reduce((count, part) => count + (part.type === "text" ? 1 : 0), 0)
    const files = list.reduce((count, part) => count + (part.type === "file" ? 1 : 0), 0)
    return language.t("context.rawMessages.summary", {
      parts: String(list.length),
      tools: String(tools),
      texts: String(texts),
      files: String(files),
    })
  })

  return (
    <div class="flex flex-col gap-2">
      <div class="flex items-center justify-between gap-2">
        <div class="text-11-regular text-text-weaker truncate">{summary()}</div>
        <Button size="small" variant="ghost" class="shrink-0" onClick={copy}>
          {copied() ? props.copiedLabel : props.copyLabel}
        </Button>
      </div>
      <ScrollView class="max-h-96">
        <Markdown
          text={`\`\`\`json\n${json()}\n\`\`\``}
          cacheKey={`context-raw-message:${props.message.id}`}
          class="text-11-regular select-text [&_.shiki]:!m-0 [&_.shiki]:!text-[11px] [&_.shiki]:whitespace-pre-wrap [&_.shiki]:break-words [&_[data-slot=markdown-copy-button]]:hidden"
        />
      </ScrollView>
    </div>
  )
}

function RawMessage(props: {
  message: Message
  getParts: (id: string) => Part[]
  opened: boolean
  time: (value: number | undefined) => string
  roleLabel: string
  emptyPreview: string
  partsCount: (count: number) => string
  copyLabel: string
  copiedLabel: string
}) {
  const preview = createMemo(() => rawMessagePreview(props.getParts(props.message.id), props.emptyPreview, props.partsCount))
  const roleColor = () => ROLE_COLOR[props.message.role]

  return (
    <Accordion.Item value={props.message.id}>
      <StickyAccordionHeader>
        <Accordion.Trigger>
          <div class="flex items-center justify-between gap-2 w-full min-w-0">
            <div class="flex items-center gap-1.5 @[20rem]:gap-2 min-w-0 flex-1">
              <span
                class="shrink-0 rounded px-1.5 py-px text-11-medium"
                style={{
                  color: roleColor(),
                  "background-color": `color-mix(in srgb, ${roleColor()} 14%, transparent)`,
                }}
              >
                {props.roleLabel}
              </span>
              <span class="hidden @[18rem]:inline shrink-0 text-11-regular font-mono text-text-weak">
                {shortMessageId(props.message.id)}
              </span>
              <span class="min-w-0 truncate text-12-regular text-text-weak">{preview()}</span>
            </div>
            <div class="flex items-center gap-2 @[20rem]:gap-3 shrink-0">
              <div class="hidden @[22rem]:block text-12-regular text-text-weak">
                {props.time(props.message.time.created)}
              </div>
              <Icon name="chevron-grabber-vertical" size="small" class="shrink-0 text-text-weak" />
            </div>
          </div>
        </Accordion.Trigger>
      </StickyAccordionHeader>
      <Accordion.Content class="bg-background-base">
        <Show when={props.opened}>
          <div class="p-3">
            <RawMessageContent
              message={props.message}
              getParts={props.getParts}
              copyLabel={props.copyLabel}
              copiedLabel={props.copiedLabel}
            />
          </div>
        </Show>
      </Accordion.Content>
    </Accordion.Item>
  )
}

const emptyMessages: Message[] = []
const emptyUserMessages: UserMessage[] = []
type InjectedTool = {
  name: string
  description: string
  inputSchema: unknown
  nameAliases?: string[]
  inputAliases?: Record<string, string>
}

function InjectedToolItem(props: { tool: InjectedTool; opened: boolean }) {
  const language = useLanguage()
  const schema = createMemo(() => JSON.stringify(props.tool.inputSchema, null, 2))
  const nameAliases = createMemo(() => props.tool.nameAliases?.filter(Boolean) ?? [])
  const inputAliases = createMemo(() => Object.entries(props.tool.inputAliases ?? {}))
  const hasAliases = createMemo(() => nameAliases().length > 0 || inputAliases().length > 0)

  return (
    <Accordion.Item value={props.tool.name}>
      <StickyAccordionHeader>
        <Accordion.Trigger>
          <div class="flex items-center gap-2 w-full min-w-0">
            <span class="shrink-0 text-11-medium font-mono text-text-strong">{props.tool.name}</span>
            <span class="min-w-0 truncate text-12-regular text-text-weak">{props.tool.description}</span>
            <Icon name="chevron-grabber-vertical" size="small" class="shrink-0 text-text-weak" />
          </div>
        </Accordion.Trigger>
      </StickyAccordionHeader>
      <Accordion.Content class="bg-background-base">
        <Show when={props.opened}>
          <div class="p-3 flex flex-col gap-2">
            <div class="rounded-md border border-border-weaker-base bg-background-stronger">
              <ScrollView class="max-h-40">
                <div class="px-3 py-2">
                  <Markdown
                    text={props.tool.description}
                    cacheKey={`context-injected-tool-desc:${props.tool.name}`}
                    class="text-11-regular text-text-weaker select-text [&_.shiki]:!m-0 [&_.shiki]:!text-[11px] [&_.shiki]:whitespace-pre-wrap [&_.shiki]:break-words [&_.shiki]:!bg-transparent [&_.shiki]:!p-0 [&_.shiki]:!border-0 [&_[data-slot=markdown-copy-button]]:hidden"
                  />
                </div>
              </ScrollView>
            </div>
            <Show when={hasAliases()}>
              <div class="rounded-md border border-border-weaker-base bg-background-stronger px-3 py-2 flex flex-col gap-1.5">
                <div class="text-11-medium text-text-weak">{language.t("context.injectedTools.aliases")}</div>
                <Show when={nameAliases().length > 0}>
                  <div class="text-11-regular font-mono text-text-weaker">
                    <span class="text-text-weak">{language.t("context.injectedTools.nameAliases")}: </span>
                    {nameAliases().join(", ")}
                  </div>
                </Show>
                <Show when={inputAliases().length > 0}>
                  <div class="text-11-regular font-mono text-text-weaker">
                    <span class="text-text-weak">{language.t("context.injectedTools.inputAliases")}: </span>
                    {inputAliases()
                      .map(([alias, canonical]) => `${alias} → ${canonical}`)
                      .join(", ")}
                  </div>
                </Show>
              </div>
            </Show>
            <div class="rounded-md border border-border-weaker-base bg-background-stronger">
              <ScrollView class="max-h-96">
                <Markdown
                  text={`\`\`\`json\n${schema()}\n\`\`\``}
                  cacheKey={`context-injected-tool:${props.tool.name}`}
                  class="text-11-regular select-text [&_.shiki]:!m-0 [&_.shiki]:!text-[11px] [&_.shiki]:whitespace-pre-wrap [&_.shiki]:break-words [&_.shiki]:!bg-transparent [&_.shiki]:!border-0 [&_.shiki]:!rounded-none [&_[data-slot=markdown-copy-button]]:hidden"
                />
              </ScrollView>
            </div>
          </div>
        </Show>
      </Accordion.Content>
    </Accordion.Item>
  )
}

export function SessionContextTab() {
  const sync = useSync()
  const language = useLanguage()
  const sdk = useSDK()
  const providers = useProviders(() => sdk().directory)
  const { params, view } = useSessionLayout()

  const info = createMemo(() => (params.id ? sync().session.get(params.id) : undefined))

  const messages = createMemo(
    () => {
      const id = params.id
      if (!id) return emptyMessages
      return (sync().data.message[id] ?? []) as Message[]
    },
    emptyMessages,
    { equals: same },
  )

  const userMessages = createMemo(
    () => messages().filter((m) => m.role === "user") as UserMessage[],
    emptyUserMessages,
    { equals: same },
  )

  const visibleUserMessages = createMemo(
    () => {
      const revert = info()?.revert?.messageID
      if (!revert) return userMessages()
      return userMessages().filter((m) => m.id < revert)
    },
    emptyUserMessages,
    { equals: same },
  )

  const usd = createMemo(
    () =>
      new Intl.NumberFormat(language.intl(), {
        style: "currency",
        currency: "USD",
      }),
  )

  const ctx = createMemo(() => getSessionContext(messages(), [...providers.all().values()]))
  const formatter = createMemo(() => createSessionContextFormatter(language.intl()))
  const requestBodyBytes = createMemo(() => {
    const message = findLast(
      messages(),
      (message) => message.role === "assistant" && message.requestBodyBytes !== undefined,
    )
    if (message?.role !== "assistant") return
    return message.requestBodyBytes
  })
  const [injectedTools] = createResource(
    () => ctx()?.message.id,
    () => {
      const message = ctx()?.message
      if (!message?.providerID || !message.modelID) return
      return sdk()
        .client.tool.list({ provider: message.providerID, model: message.modelID })
        .then((result) =>
          (result.data ?? []).map((item) => ({
            name: item.id,
            description: item.description,
            inputSchema: item.parameters,
            nameAliases: item.nameAliases,
            inputAliases: item.inputAliases,
          })),
        )
        .catch(() => undefined)
    },
  )
  const fallbackSystemPrompts = createMemo(() => {
    const msg = findLast(visibleUserMessages(), (message) => !!message.system)
    const system = msg?.system
    if (!system?.trim()) return []
    return [system]
  })
  const systemPromptPreviewKey = createMemo(
    () => {
      const sessionID = params.id
      const messageID = ctx()?.message.id
      if (!sessionID || !messageID) return
      const session = info()
      return [
        sdk().directory,
        sessionID,
        messageID,
        session?.agent,
        session?.model?.providerID,
        session?.model?.id,
        session?.model?.variant,
      ] as const
    },
    undefined,
    { equals: same },
  )
  const [systemPromptPreview] = createResource(
    systemPromptPreviewKey,
    ([, sessionID]) =>
      sdk()
        .client.experimental.session.systemPrompt({ sessionID })
        .then((result) => result.data)
        .catch(() => undefined),
  )

  const cost = createMemo(() => {
    return usd().format(info()?.cost ?? 0)
  })

  const counts = createMemo(() => {
    const all = messages()
    const user = all.reduce((count, x) => count + (x.role === "user" ? 1 : 0), 0)
    const assistant = all.reduce((count, x) => count + (x.role === "assistant" ? 1 : 0), 0)
    return {
      all: all.length,
      user,
      assistant,
    }
  })

  const systemPrompts = createMemo(() => systemPromptPreview() ?? fallbackSystemPrompts())
  const systemPrompt = createMemo(() => systemPrompts().join("\n"))

  const providerLabel = createMemo(() => {
    const c = ctx()
    if (!c) return "—"
    return c.providerLabel
  })

  const modelLabel = createMemo(() => {
    const c = ctx()
    if (!c) return "—"
    return c.modelLabel
  })

  const emptyBreakdown = { segments: [], prompts: [], tools: [] }

  const breakdown = createMemo(
    on(
      () => [ctx()?.message.id, ctx()?.contextInput, messages().length, systemPrompts().join("\0")],
      () => {
        const c = ctx()
        if (!c?.contextInput) return emptyBreakdown
        try {
          return estimateSessionContextBreakdown({
            messages: messages(),
            parts: sync().data.part as Record<string, Part[] | undefined>,
            input: c.contextInput,
            systemPrompts: systemPrompts(),
            boundaryMessageID: c.message.id,
          })
        } catch {
          return emptyBreakdown
        }
      },
    ),
  )

  const segments = createMemo(() => breakdown()?.segments ?? emptyBreakdown.segments)
  const promptShares = createMemo(() => breakdown()?.prompts ?? emptyBreakdown.prompts)
  const toolShares = createMemo(() => breakdown()?.tools ?? emptyBreakdown.tools)

  const breakdownLabel = (key: SessionContextBreakdownKey) => {
    if (key === "system") return language.t("context.breakdown.system")
    if (key === "user") return language.t("context.breakdown.user")
    if (key === "assistant") return language.t("context.breakdown.assistant")
    if (key === "tool") return language.t("context.breakdown.tool")
    return language.t("context.breakdown.other")
  }

  const translate = (key: string, vars?: Record<string, string>) =>
    language.t(key as Parameters<typeof language.t>[0], vars)

  const t = (key: string) => language.t(key as Parameters<typeof language.t>[0])

  const statGroups = () =>
    [
      {
        title: t("context.stats.group.usage"),
        rows: [
          { label: t("context.stats.usage"), value: () => formatter().percent(ctx()?.usage) },
          { label: t("context.stats.totalTokens"), value: () => formatter().number(ctx()?.total) },
          { label: t("context.stats.limit"), value: () => formatter().number(ctx()?.limit) },
        ],
      },
      {
        title: t("context.stats.group.tokens"),
        rows: [
          { label: t("context.stats.inputTokens"), value: () => formatter().number(ctx()?.input) },
          { label: t("context.stats.outputTokens"), value: () => formatter().number(ctx()?.message.tokens.output) },
          {
            label: t("context.stats.reasoningTokens"),
            value: () => formatter().number(ctx()?.message.tokens.reasoning),
          },
          {
            label: t("context.stats.cacheTokens"),
            value: () =>
              `${formatter().number(ctx()?.message.tokens.cache.read)} / ${formatter().number(ctx()?.message.tokens.cache.write)}`,
          },
          { label: t("context.stats.requestBody"), value: () => formatter().bytes(requestBodyBytes()) },
        ],
      },
      {
        title: t("context.stats.group.session"),
        rows: [
          { label: t("context.stats.session"), value: () => info()?.title ?? params.id ?? "—" },
          { label: t("context.stats.provider"), value: providerLabel },
          { label: t("context.stats.model"), value: modelLabel },
          { label: t("context.stats.messages"), value: () => counts().all.toLocaleString(language.intl()) },
          { label: t("context.stats.userMessages"), value: () => counts().user.toLocaleString(language.intl()) },
          {
            label: t("context.stats.assistantMessages"),
            value: () => counts().assistant.toLocaleString(language.intl()),
          },
          { label: t("context.stats.totalCost"), value: cost },
          { label: t("context.stats.sessionCreated"), value: () => formatter().time(info()?.time.created) },
          { label: t("context.stats.lastActivity"), value: () => formatter().time(ctx()?.message.time.created) },
        ],
      },
    ] satisfies { title: string; rows: { label: string; value: () => JSX.Element }[] }[]

  let scroll: HTMLDivElement | undefined
  let frame: number | undefined
  let pending: { x: number; y: number } | undefined
  const [expandedTools, setExpandedTools] = createSignal<string[]>([])
  const [expanded, setExpanded] = createSignal<string[]>([])
  const getParts = (id: string) => (sync().data.part[id] ?? []) as Part[]

  const roleLabel = (role: Message["role"]) => {
    if (role === "user") return language.t("context.rawMessages.role.user")
    return language.t("context.rawMessages.role.assistant")
  }

  const restoreScroll = () => {
    const el = scroll
    if (!el) return

    const s = view().scroll("context")
    if (!s) return

    if (el.scrollTop !== s.y) el.scrollTop = s.y
    if (el.scrollLeft !== s.x) el.scrollLeft = s.x
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    pending = {
      x: event.currentTarget.scrollLeft,
      y: event.currentTarget.scrollTop,
    }
    if (frame !== undefined) return

    frame = requestAnimationFrame(() => {
      frame = undefined

      const next = pending
      pending = undefined
      if (!next) return

      view().setScroll("context", next)
    })
  }

  createEffect(
    on(
      () => messages().length,
      () => {
        requestAnimationFrame(restoreScroll)
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => expanded().join("\0"),
      () => {
        requestAnimationFrame(restoreScroll)
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    if (frame === undefined) return
    cancelAnimationFrame(frame)
  })

  return (
    <ScrollView
      class="@container h-full"
      viewportRef={(el) => {
        scroll = el
        restoreScroll()
      }}
      onScroll={handleScroll}
    >
      <div class="px-4 @[24rem]:px-6 pt-4 pb-10 flex flex-col gap-6 min-w-0">
        <div class="flex flex-col gap-4 min-w-0">
          <For each={statGroups()}>
            {(group) => (
              <StatSection title={group.title}>
                <For each={group.rows}>{(row) => <StatRow label={row.label} value={row.value()} />}</For>
              </StatSection>
            )}
          </For>
        </div>

        <Show when={segments().length > 0}>
          <div class="flex flex-col gap-4">
            <div class="flex flex-col gap-2">
              <div class="text-12-regular text-text-weak">{language.t("context.breakdown.title")}</div>
              <div class="h-2.5 w-full rounded-full bg-surface-base overflow-hidden flex">
                <For each={segments()}>
                  {(segment) => (
                    <div class="h-full min-w-0" style={{ width: `${segment.width}%` }}>
                      <BreakdownTooltip
                        segment={segment}
                        label={breakdownLabel(segment.key)}
                        number={formatter().number}
                        t={translate}
                        class="h-full w-full"
                      >
                        <div
                          class="h-full w-full cursor-default"
                          style={{ "background-color": BREAKDOWN_COLOR[segment.key] }}
                        />
                      </BreakdownTooltip>
                    </div>
                  )}
                </For>
              </div>
              <div class="flex flex-wrap gap-x-3 gap-y-1">
                <For each={segments()}>
                  {(segment) => (
                    <BreakdownTooltip
                      segment={segment}
                      label={breakdownLabel(segment.key)}
                      number={formatter().number}
                      t={translate}
                    >
                      <div class="flex items-center gap-1 text-11-regular text-text-weak cursor-default">
                        <div class="size-2 rounded-sm" style={{ "background-color": BREAKDOWN_COLOR[segment.key] }} />
                        <div>{breakdownLabel(segment.key)}</div>
                        <div class="text-text-weaker tabular-nums">
                          {formatter().number(segment.tokens)} · {segment.percent.toLocaleString(language.intl())}%
                        </div>
                      </div>
                    </BreakdownTooltip>
                  )}
                </For>
              </div>
            </div>

            <div class="grid grid-cols-1 @[40rem]:grid-cols-2 gap-4 min-w-0">
              <ShareList
                title={language.t("context.breakdown.prompts.title")}
                empty={language.t("context.breakdown.prompts.empty")}
                rows={promptShares()}
                number={formatter().number}
                t={translate}
                intl={language.intl()}
              />
              <ShareList
                title={language.t("context.breakdown.tools.title")}
                empty={language.t("context.breakdown.tools.empty")}
                rows={toolShares()}
                number={formatter().number}
                t={translate}
                intl={language.intl()}
              />
            </div>
          </div>
        </Show>

        <div class="flex flex-col gap-2">
          <div class="text-12-regular text-text-weak">{language.t("context.injectedTools.title")}</div>
          <Show
            when={injectedTools()}
            fallback={
              <div class="text-11-regular text-text-weaker">{language.t("context.injectedTools.unavailable")}</div>
            }
          >
            {(tools) => (
              <Show
                when={tools().length > 0}
                fallback={
                  <div class="text-11-regular text-text-weaker">{language.t("context.injectedTools.empty")}</div>
                }
              >
                <div class="text-11-regular text-text-weaker">{language.t("context.injectedTools.description")}</div>
                <Accordion
                  multiple
                  value={expandedTools()}
                  onChange={(value) => setExpandedTools(Array.isArray(value) ? value : value ? [value] : [])}
                >
                  <For each={tools()}>
                    {(tool) => (
                      <InjectedToolItem tool={tool} opened={expandedTools().includes(tool.name)} />
                    )}
                  </For>
                </Accordion>
              </Show>
            )}
          </Show>
        </div>

        <div class="flex flex-col gap-2">
          <div class="text-12-regular text-text-weak">{language.t("context.rawMessages.title")}</div>
          <Accordion
            multiple
            value={expanded()}
            onChange={(value) => setExpanded(Array.isArray(value) ? value : value ? [value] : [])}
          >
            <For each={messages()}>
              {(message) => (
                <RawMessage
                  message={message}
                  getParts={getParts}
                  opened={expanded().includes(message.id)}
                  time={formatter().time}
                  roleLabel={roleLabel(message.role)}
                  emptyPreview={language.t("context.rawMessages.preview.empty")}
                  partsCount={(count) => language.t("context.rawMessages.preview.parts", { count: String(count) })}
                  copyLabel={language.t("context.rawMessages.copy")}
                  copiedLabel={language.t("context.rawMessages.copied")}
                />
              )}
            </For>
          </Accordion>
        </div>
      </div>
    </ScrollView>
  )
}
