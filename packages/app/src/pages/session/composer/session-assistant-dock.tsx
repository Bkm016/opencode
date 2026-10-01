import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on } from "solid-js"
import type { Part, Session } from "@opencode-ai/sdk/v2/client"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { DockTray } from "@opencode-ai/ui/dock-surface"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { assistantMode, findAssistant } from "@/components/prompt-input/assistant"

type Line = { id: string; role: "user" | "assistant" | "tool"; text: string }

/** 输入框上方的助手栏：收起时一行显示助手的状态与最新进展，展开看助手这边的完整往来。 */
export function SessionAssistantDock(props: { sessionID: string }) {
  const sdk = useSDK()
  const sync = useSync()
  const language = useLanguage()
  const navigate = useNavigate()

  // 刷新页面后助手会话可能还不在会话列表里，按需向服务端补查一次
  const [fetched, setFetched] = createSignal<Session>()
  createEffect(
    on(
      () => props.sessionID,
      (id) => {
        setFetched(undefined)
        void sdk()
          .client.session.children({ sessionID: id })
          .then((x) => {
            if (props.sessionID === id) setFetched(findAssistant(x.data ?? [], id))
          })
          .catch(() => {})
      },
    ),
  )
  const helper = createMemo(() => findAssistant(sync().data.session, props.sessionID) ?? fetched())

  createEffect(
    on(
      () => helper()?.id,
      (id) => {
        if (id)
          void sync()
            .session.sync(id)
            .catch(() => {})
      },
    ),
  )

  const busy = createMemo(() => {
    const id = helper()?.id
    return !!id && sync().data.session_working(id)
  })

  const lines = createMemo(() => {
    const id = helper()?.id
    if (!id) return []
    const data = sync().data
    const result: Line[] = []
    for (const message of data.message[id] ?? []) {
      const parts = (data.part[message.id] ?? []) as Part[]
      if (message.role === "user") {
        const text = parts
          .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : []))
          .join("\n")
          .trim()
        if (text) result.push({ id: message.id, role: "user", text })
        continue
      }
      for (const part of parts) {
        if (part.type === "text" && !part.synthetic && part.text.trim()) {
          result.push({ id: part.id, role: "assistant", text: part.text.trim() })
        }
        if (part.type === "tool") {
          const state = part.state as { title?: string; input?: Record<string, unknown> }
          const target = state.title || (typeof state.input?.filePath === "string" ? state.input.filePath : "")
          result.push({ id: part.id, role: "tool", text: target ? `${part.tool} · ${target}` : part.tool })
        }
      }
    }
    return result
  })

  const latest = createMemo(() => lines().at(-1))
  const summary = createMemo(() => {
    const line = latest()
    if (!line) return ""
    if (line.role === "user") return busy() ? language.t("assistant.working") : language.t("assistant.waiting")
    return firstLine(line.role === "assistant" && !busy() ? line.text : lastLine(line.text))
  })

  // 用过之后常驻会占地方：只在助手模式、助手忙、或有尚未看过的结果时显示
  const [seen, setSeen] = createSignal<string>()
  const unread = createMemo(() => {
    const line = latest()
    return !!line && line.role === "assistant" && seen() !== line.id
  })
  const visible = createMemo(
    () => !!helper() && lines().length > 0 && (busy() || assistantMode(props.sessionID) || unread()),
  )

  const [expanded, setExpanded] = createSignal(false)
  // 首次展开后才挂载内容（markdown 渲染有开销），之后保留，收起时也能播放动画
  const [mounted, setMounted] = createSignal(false)
  const toggleExpanded = () => {
    setMounted(true)
    setExpanded((value) => !value)
  }

  // 跟随到底部；用户往上翻时不打扰。markdown 异步渲染会改变高度，所以按内容尺寸变化来跟随
  const [box, setBox] = createSignal<HTMLDivElement>()
  const [content, setContent] = createSignal<HTMLDivElement>()
  let follow = true
  const stick = () => {
    const el = box()
    if (el && follow && expanded()) el.scrollTop = el.scrollHeight
  }
  createResizeObserver(content, stick)
  createEffect(
    on(expanded, (value) => {
      if (!value) return
      follow = true
      requestAnimationFrame(stick)
    }),
  )

  const open = () => {
    const id = helper()?.id
    if (!id) return
    navigate(`/${base64Encode(sdk().directory)}/session/${id}`)
  }

  return (
    <Show when={visible()}>
      <DockTray data-component="session-assistant-dock" class="py-1">
        <div
          class="pl-3 pr-2 py-1 flex items-center gap-2 cursor-pointer"
          role="button"
          tabIndex={0}
          aria-expanded={expanded()}
          onClick={toggleExpanded}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return
            if (event.key !== "Enter" && event.key !== " ") return
            event.preventDefault()
            toggleExpanded()
          }}
        >
          <span
            data-slot="assistant-dock-dot"
            data-busy={busy() ? "" : undefined}
            class="shrink-0 size-1.5 rounded-full"
            classList={{ "bg-icon-info-active": busy(), "bg-icon-weak-base": !busy() }}
          />
          <span class="shrink-0 text-13-medium text-text-strong">{language.t("assistant.title")}</span>
          <span class="min-w-16 flex-1 truncate text-12-regular text-text-weak">
            <Show when={!expanded()}>{summary()}</Show>
          </span>
          <div class="flex items-center gap-1 shrink-0">
            <IconButton
              icon="square-arrow-top-right"
              size="normal"
              variant="ghost"
              onClick={(event) => {
                event.stopPropagation()
                open()
              }}
              aria-label={language.t("assistant.open")}
            />
            <Show when={!busy() && !assistantMode(props.sessionID)}>
              <IconButton
                icon="close-small"
                size="normal"
                variant="ghost"
                onClick={(event) => {
                  event.stopPropagation()
                  setSeen(latest()?.id)
                  setExpanded(false)
                }}
                aria-label={language.t("common.close")}
              />
            </Show>
            <IconButton
              icon="chevron-down"
              size="normal"
              variant="ghost"
              data-slot="dock-chevron"
              style={{ transform: `rotate(${expanded() ? 0 : 180}deg)` }}
              onClick={(event) => {
                event.stopPropagation()
                toggleExpanded()
              }}
              aria-label={expanded() ? language.t("session.todo.collapse") : language.t("session.todo.expand")}
            />
          </div>
        </div>
        <div data-slot="dock-reveal" data-open={expanded() ? "" : undefined} inert={!expanded()}>
          <div>
            <Show when={mounted()}>
              <div
                ref={setBox}
                data-slot="assistant-dock-body"
                class="pl-6.5 pr-3 pb-2 max-h-[min(24rem,45vh)] overflow-y-auto overscroll-contain no-scrollbar"
                onScroll={(event) => {
                  const el = event.currentTarget
                  follow = el.scrollHeight - el.scrollTop - el.clientHeight < 8
                }}
              >
                <div ref={setContent} class="flex flex-col gap-1.5">
                  <For each={lines()}>
                    {(line) => (
                      <Switch>
                        <Match when={line.role === "assistant"}>
                          <Markdown
                            data-role="assistant"
                            class="shrink-0 min-w-0 text-13-regular text-text-base"
                            text={line.text}
                            cacheKey={line.id}
                            streaming={busy() && line.id === latest()?.id}
                          />
                        </Match>
                        <Match when={line.role === "user"}>
                          <div
                            data-role="user"
                            class="shrink-0 whitespace-pre-wrap break-words text-13-medium text-text-strong"
                          >
                            {line.text}
                          </div>
                        </Match>
                        <Match when={line.role === "tool"}>
                          <div data-role="tool" class="shrink-0 truncate text-12-regular text-text-weak font-mono">
                            {line.text}
                          </div>
                        </Match>
                      </Switch>
                    )}
                  </For>
                </div>
              </div>
            </Show>
          </div>
        </div>
      </DockTray>
    </Show>
  )
}

function firstLine(text: string) {
  return text.split("\n").find((line) => line.trim()) ?? ""
}

function lastLine(text: string) {
  const all = text.split("\n")
  for (let i = all.length - 1; i >= 0; i--) if (all[i].trim()) return all[i]
  return ""
}
