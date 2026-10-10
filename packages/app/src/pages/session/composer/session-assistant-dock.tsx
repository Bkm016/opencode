import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on } from "solid-js"
import type { Part, Session } from "@opencode-ai/sdk/v2/client"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { showToast } from "@opencode-ai/ui/toast"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { findAssistant, setAssistantMode } from "@/components/prompt-input/assistant"
import { ComposerPanelBar, useComposerTabs } from "./session-composer-tabs"

type Line = { id: string; role: "user" | "assistant" | "tool"; text: string }

/** 输入框上方的助手栏：收起时一行显示助手的状态与最新进展，展开看助手这边的完整往来。 */
export function SessionAssistantDock(props: { sessionID: string }) {
  const sdk = useSDK()
  const sync = useSync()
  const language = useLanguage()
  const navigate = useNavigate()

  // 助手只属于主会话：子会话（含助手会话本身）不显示助手栏
  const child = createMemo(() => !!sync().session.get(props.sessionID)?.parentID)

  // 刷新页面后助手会话可能还不在会话列表里，按需向服务端补查一次
  const [fetched, setFetched] = createSignal<Session>()
  createEffect(
    on(
      () => props.sessionID,
      (id) => {
        setFetched(undefined)
        if (child()) return
        void sdk()
          .client.session.children({ sessionID: id })
          .then((x) => {
            if (props.sessionID === id) setFetched(findAssistant(x.data ?? [], id))
          })
          .catch(() => {})
      },
    ),
  )
  // 正在删除的助手立即隐藏，不等服务端事件
  const [removed, setRemoved] = createSignal(new Set<string>())
  const helper = createMemo(() => {
    if (child()) return undefined
    const found = findAssistant(sync().data.session, props.sessionID) ?? fetched()
    return found && !removed().has(found.id) ? found : undefined
  })

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

  const visible = createMemo(() => !!helper() && lines().length > 0)

  // 关闭即删除助手会话（连同它的对话）；下次再用助手会新建一个
  const remove = async () => {
    const id = helper()?.id
    if (!id) return
    setRemoved((prev) => new Set(prev).add(id))
    tabs.close()
    setAssistantMode(props.sessionID, false)
    // 服务端删除时会先停掉仍在进行的回复
    await sdk()
      .client.session.delete({ sessionID: id })
      .catch((err: unknown) => {
        setRemoved((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
        showToast({
          variant: "error",
          title: language.t("session.delete.failed.title"),
          description: err instanceof Error ? err.message : String(err),
        })
      })
  }

  const tabs = useComposerTabs()
  const expanded = () => tabs.expanded("assistant")
  tabs.use(visible, {
    id: "assistant",
    order: 3,
    label: () => language.t("assistant.title"),
    tone: () => (busy() ? "busy" : "idle"),
    preview: summary,
  })

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
    <Show when={visible() && tabs.active("assistant")}>
      <div data-component="session-assistant-dock">
        <ComposerPanelBar
          actions={
            <>
              <IconButton
                icon="square-arrow-top-right"
                size="small"
                variant="ghost"
                onClick={open}
                aria-label={language.t("assistant.open")}
              />
              <IconButton
                icon="close-small"
                size="small"
                variant="ghost"
                onClick={() => void remove()}
                aria-label={language.t("common.close")}
              />
            </>
          }
        >
          <span class="min-w-0 truncate text-text-weak">{busy() ? language.t("assistant.working") : summary()}</span>
        </ComposerPanelBar>
        <div
          ref={setBox}
          data-slot="assistant-dock-body"
          class="px-2 pt-0.5 pb-1.5 max-h-[min(20rem,40vh)] overflow-y-auto overscroll-contain no-scrollbar"
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
      </div>
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
