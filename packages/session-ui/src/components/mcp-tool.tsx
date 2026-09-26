import { For, Show, createMemo, createSignal } from "solid-js"
import type { Part, ToolPart } from "@opencode-ai/sdk/v2"
import { TextShimmer } from "@opencode-ai/ui/text-shimmer"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Icon } from "@opencode-ai/ui/icon"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { formatToolDuration } from "./tool-group"

export type McpInfo = { server: string; tool: string }

/**
 * 识别 MCP 调用并拆出服务名与原始工具名。
 * 新数据由服务端写入 metadata.mcp；失败的调用和旧数据没有该字段，退回按首个下划线拆分未注册的工具名。
 */
export function mcpInfo(part: Part, known: (tool: string) => boolean): McpInfo | undefined {
  if (part.type !== "tool") return
  const meta = "metadata" in part.state ? (part.state.metadata as Record<string, any> | undefined) : undefined
  const mcp = meta?.mcp
  if (mcp && typeof mcp.server === "string" && typeof mcp.tool === "string") return mcp
  if (known(part.tool)) return
  const idx = part.tool.indexOf("_")
  if (idx <= 0 || idx === part.tool.length - 1) return
  return { server: part.tool.slice(0, idx), tool: part.tool.slice(idx + 1) }
}

function inline(value: unknown) {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (value === null || value === undefined) return ""
  return JSON.stringify(value)
}

/** 折叠行上的参数摘要：优先展示语义明确的字段值，其余按 key=value 拼接 */
function preview(input: Record<string, unknown>) {
  const lead = ["query", "q", "url", "path", "filePath", "title", "name", "id"]
    .map((key) => input[key])
    .find((value): value is string => typeof value === "string" && value.length > 0)
  const rest = Object.entries(input)
    .filter(([, value]) => value !== lead && value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${inline(value)}`)
  return [lead, ...rest].filter(Boolean).join("  ")
}

/** 结果多为 JSON 字符串，能解析就格式化，否则原样展示 */
function pretty(text: string) {
  const trimmed = text.trim()
  if (!/^[[{]/.test(trimmed)) return trimmed
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    return trimmed
  }
}

function size(text: string) {
  const bytes = new TextEncoder().encode(text).length
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`
}

export function McpGroupSummary(props: { parts: ToolPart[]; known: (tool: string) => boolean }) {
  const i18n = useI18n()
  const servers = createMemo(() => [
    ...new Set(props.parts.map((part) => mcpInfo(part, props.known)?.server).filter((s): s is string => !!s)),
  ])
  const count = () => props.parts.length
  return (
    <span>
      {servers().join("、")}
      {" · "}
      {i18n.t(count() === 1 ? "ui.messagePart.mcp.call.one" : "ui.messagePart.mcp.call.other", { count: count() })}
    </span>
  )
}

export function McpGroupItem(props: { part: ToolPart; known: (tool: string) => boolean; showServer?: boolean }) {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)
  const [copied, setCopied] = createSignal(false)
  const info = createMemo(() => mcpInfo(props.part, props.known) ?? { server: "mcp", tool: props.part.tool })
  const status = () => props.part.state.status
  const pending = () => status() === "pending" || status() === "running"
  const errored = () => status() === "error"
  const input = createMemo(() => (props.part.state.input ?? {}) as Record<string, unknown>)
  const args = createMemo(() => Object.entries(input()).filter(([, value]) => value !== undefined))
  const summary = createMemo(() => preview(input()))
  const output = createMemo(() => {
    const state = props.part.state
    if (state.status === "completed") return pretty(state.output ?? "")
    return ""
  })
  const error = createMemo(() => {
    const state = props.part.state
    if (state.status !== "error") return ""
    return String(state.error ?? "").replace(/^Error:\s*/, "").trim()
  })
  const duration = createMemo(() => formatToolDuration(props.part))

  const copy = async () => {
    const text = output() || error()
    if (!text || !navigator.clipboard?.writeText) return
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div data-component="mcp-item-container" data-open={open() ? "true" : "false"}>
      <div
        data-component="context-tool-row"
        class="cursor-pointer"
        role="button"
        tabIndex={0}
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return
          event.preventDefault()
          setOpen(!open())
        }}
      >
        <div data-slot="context-tool-main">
          <Show when={props.showServer}>
            <span data-slot="context-tool-tag">{info().server}</span>
          </Show>
          <span data-slot="context-tool-target" title={props.part.tool}>
            <TextShimmer text={info().tool} active={pending()} />
          </span>
          <Show when={summary()}>
            <span data-slot="context-tool-path" title={summary()}>
              {summary()}
            </span>
          </Show>
        </div>
        <div data-slot="context-tool-meta">
          <Show when={pending()}>
            <span data-slot="context-tool-running">
              <Spinner class="size-3" />
            </span>
          </Show>
          <Show when={!pending() && duration()}>
            <span data-slot="context-tool-duration">{duration()}</span>
          </Show>
          <Show when={errored()}>
            <span data-slot="bash-trigger-exit" data-exit="fail" title={error() || undefined}>
              {i18n.t("ui.toolErrorCard.failed")}
            </span>
          </Show>
          <span class="edit-tool-card-arrow" data-open={open() ? "true" : "false"}>
            <Icon name="chevron-down" size="small" />
          </span>
        </div>
      </div>

      <div class="edit-tool-card-body-wrapper" data-open={open() ? "true" : "false"}>
        <div class="edit-tool-card-body-inner">
          <Show when={open()}>
            <div data-component="mcp-output">
              <Show when={args().length > 0}>
                <div data-slot="mcp-section">
                  <div data-slot="mcp-label">{i18n.t("ui.messagePart.mcp.input")}</div>
                  <dl data-slot="mcp-args">
                    <For each={args()}>
                      {([key, value]) => (
                        <>
                          <dt>{key}</dt>
                          <dd data-type={typeof value === "string" ? "string" : "value"}>
                            {typeof value === "object" && value !== null ? JSON.stringify(value) : inline(value)}
                          </dd>
                        </>
                      )}
                    </For>
                  </dl>
                </div>
              </Show>
              <Show when={output() || error()}>
                <div data-slot="mcp-section" data-kind={errored() ? "error" : "result"}>
                  <div data-slot="mcp-label">
                    <span>{i18n.t(errored() ? "ui.messagePart.mcp.error" : "ui.messagePart.mcp.output")}</span>
                    <Show when={output()}>
                      <span data-slot="mcp-size">{size(output())}</span>
                    </Show>
                    <span data-slot="mcp-label-tail">
                      <TooltipV2
                        value={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copy")}
                        placement="top"
                      >
                        <IconButtonV2
                          icon={<IconV2 name={copied() ? "check" : "outline-copy"} size="small" />}
                          size="normal"
                          variant="ghost-muted"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={(event) => {
                            event.stopPropagation()
                            void copy()
                          }}
                          aria-label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copy")}
                        />
                      </TooltipV2>
                    </span>
                  </div>
                  <div data-slot="mcp-scroll" data-scrollable tabIndex={0}>
                    <pre data-slot="mcp-pre">
                      <code>{errored() ? error() : output()}</code>
                    </pre>
                  </div>
                </div>
              </Show>
            </div>
          </Show>
        </div>
      </div>
    </div>
  )
}
