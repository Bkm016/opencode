import { createSignal, createMemo, createEffect, Show } from "solid-js"
import stripAnsi from "strip-ansi"
import { Icon } from "@opencode-ai/ui/icon"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { TextShimmer } from "@opencode-ai/ui/text-shimmer"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import "./edit-tool-card.css"

export interface ScriptToolCardProps {
  tool: "bash" | "python"
  prompt: string
  codeKey: "command" | "code"
  status?: string
  defaultOpen?: boolean
  forceOpen?: boolean
  input: Record<string, any>
  metadata?: Record<string, any>
  output?: string
  error?: string
}

async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {}
  }
  return false
}

export function ScriptToolCard(props: ScriptToolCardProps) {
  const i18n = useI18n()
  const pending = () => props.status === "pending" || props.status === "running"
  const errored = () => props.status === "error"

  // 运行中的命令默认自动展开，方便用户实时查看进度；完成时尊重 defaultOpen
  const [open, setOpen] = createSignal(props.defaultOpen ?? pending())

  createEffect(() => {
    if (props.forceOpen || pending()) {
      setOpen(true)
    }
  })

  const errorText = createMemo(() => {
    if (!errored()) return ""
    const meta = props.metadata ?? {}
    if (meta.interrupted === true) return i18n.t("ui.message.interrupted")
    const raw = props.error ?? meta.error
    return typeof raw === "string" ? raw.replace(/^Error:\s*/, "").trim() : ""
  })

  const remote = createMemo(() => {
    const value = props.input.host ?? props.metadata?.host
    return typeof value === "string" && value ? value : undefined
  })
  const host = createMemo(() => remote() ?? "localhost")
  const workdir = createMemo(() => {
    const value = props.input.workdir ?? props.metadata?.workdir
    return typeof value === "string" && value ? value : undefined
  })

  const scriptContent = createMemo(() => {
    const raw = props.input[props.codeKey] ?? props.metadata?.[props.codeKey] ?? ""
    return String(raw).replace(/\r\n?/g, "\n").trimEnd()
  })

  const scriptPreview = createMemo(() => {
    const lines = scriptContent().split("\n")
    const first = lines.find((line: string) => line.trim()) ?? ""
    const extra = lines.length - 1
    return extra > 0 ? `${first.trimEnd()} … (${extra + 1} lines)` : first
  })

  const outputText = createMemo(() => {
    const raw = props.output ?? props.metadata?.output
    const text = typeof raw === "string" ? raw : ""
    return stripAnsi(text).replace(/\r\n?/g, "\n").trimEnd()
  })

  const exit = createMemo(() => {
    const code = props.metadata?.exit
    return typeof code === "number" ? code : undefined
  })
  const failed = createMemo(() => exit() !== undefined && exit() !== 0)

  const location = createMemo(() => {
    const parts: string[] = []
    if (remote()) parts.push(remote()!)
    if (workdir()) parts.push(workdir()!)
    return parts.join(" · ")
  })

  const [copied, setCopied] = createSignal(false)
  let scrollRef: HTMLDivElement | undefined

  const scrollToEnd = () => {
    const el = scrollRef
    if (!el) return
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
  }

  createEffect(() => {
    outputText()
    scrollToEnd()
  })

  const handleCopy = async () => {
    const prefix = props.prompt === "$" ? "$ " : ""
    const content = `${prefix}${scriptContent()}${outputText() ? "\n\n" + outputText() : ""}`
    if (await copyToClipboard(content)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div class="edit-tool-card" data-component={`${props.tool}-tool-card`}>
      <div
        class="edit-tool-card-trigger"
        role="button"
        tabIndex={0}
        onClick={() => setOpen(!open())}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            setOpen(!open())
          }
        }}
      >
        <div class="edit-tool-card-info">
          <span data-slot="bash-trigger-prompt">{props.prompt}</span>
          <span data-slot="bash-trigger-cmd">
            <TextShimmer text={scriptPreview()} active={pending()} />
          </span>
          <Show when={!pending() && location()}>
            <span data-slot="bash-trigger-location">{location()}</span>
          </Show>
        </div>

        <div class="edit-tool-card-tail" onClick={(e) => e.stopPropagation()}>
          <Show when={!pending() && failed()}>
            <span data-slot="bash-trigger-exit" data-exit="fail">
              {i18n.t("ui.tool.shell.exit")} {exit()}
            </span>
          </Show>
          <Show when={errored()}>
            <span data-slot="bash-trigger-exit" data-exit="fail" title={errorText() || undefined}>
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
            <div data-component="bash-output">
            <div data-slot="bash-header">
              <Show when={host()}>
                <span data-slot="bash-meta">
                  <span data-slot="bash-meta-key">{i18n.t("ui.tool.shell.host")}</span>
                  <span data-slot="bash-meta-value" data-accent>
                    {host()}
                  </span>
                </span>
              </Show>
              <Show when={workdir()}>
                <span data-slot="bash-meta">
                  <span data-slot="bash-meta-key">{i18n.t("ui.tool.shell.workdir")}</span>
                  <span data-slot="bash-meta-value">{workdir()}</span>
                </span>
              </Show>
              <span data-slot="bash-header-tail">
                <Show when={exit() !== undefined}>
                  <span data-slot="bash-meta">
                    <span data-slot="bash-meta-key">{i18n.t("ui.tool.shell.exit")}</span>
                    <span data-slot="bash-meta-value" data-exit={exit() === 0 ? "ok" : "fail"}>
                      {exit()}
                    </span>
                  </span>
                </Show>
                <TooltipV2 value={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copy")} placement="top">
                  <IconButtonV2
                    icon={<IconV2 name={copied() ? "check" : "outline-copy"} size="small" />}
                    size="normal"
                    variant="ghost-muted"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={handleCopy}
                    aria-label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copy")}
                  />
                </TooltipV2>
              </span>
            </div>

            <div
              data-slot="bash-scroll"
              data-scrollable
              tabIndex={0}
              role="region"
              aria-label={i18n.t("ui.scrollView.ariaLabel")}
              ref={(el) => {
                scrollRef = el
                scrollToEnd()
              }}
            >
              <pre data-slot="bash-pre" data-section="command">
                <code>{scriptContent()}</code>
              </pre>
              <Show when={outputText()}>
                <pre data-slot="bash-pre" data-section="output">
                  <code>{outputText()}</code>
                </pre>
              </Show>
              <Show when={errored() && errorText()}>
                <pre data-slot="bash-pre" data-section="error">
                  <code>{errorText()}</code>
                </pre>
              </Show>
            </div>
          </div>
        </Show>
      </div>
    </div>
  </div>
  )
}
