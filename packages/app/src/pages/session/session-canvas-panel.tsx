import { createEffect, createMemo, lazy, onCleanup, Show, Suspense } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Root, Portal, Overlay } from "@kobalte/core/dialog"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import type { CanvasReference } from "@opencode-ai/session-ui/context/canvas"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { usePrompt } from "@/context/prompt"
import { useLayout } from "@/context/layout"
import { useSessionLayout } from "./session-layout"
import { pathKey } from "@/utils/path-key"
import { formatServerError } from "@/utils/server-errors"

const CanvasDocument = lazy(async () => {
  const { CanvasDocument } = await import("@opencode-ai/session-ui/canvas-document")
  return { default: CanvasDocument }
})

export function SessionCanvasPanel(props: { canvas: CanvasReference }) {
  const sdk = useSDK()
  const sync = useSync()
  const prompt = usePrompt()
  const layout = useLayout()
  const i18n = useI18n()
  const { params, view } = useSessionLayout()
  const [state, setState] = createStore({
    content: undefined as string | undefined,
    savedContent: undefined as string | undefined,
    loading: false,
    error: "",
    selection: "",
    zoom: 100,
    expanded: false,
    copy: undefined as (() => Promise<void>) | undefined,
    copying: false,
    copied: false,
    copyError: "",
  })
  let documentRoot: HTMLDivElement | undefined
  let request = 0
  let abort: AbortController | undefined
  const snapshot = createMemo(() => {
    if (state.savedContent !== undefined) return state.savedContent
    const part = sync().data.part[props.canvas.messageID]?.find((part) => part.id === props.canvas.partID)
    if (part?.type !== "tool" || part.tool !== "canvas" || part.state.status !== "completed") return
    const content = part.state.metadata.content
    return typeof content === "string" ? content : undefined
  })

  const refresh = async () => {
    const sessionID = params.id
    if (!sessionID) return
    const current = ++request
    abort?.abort()
    const controller = new AbortController()
    abort = controller
    setState("loading", true)
    await sdk()
      .client.session.canvas({ sessionID, partID: props.canvas.partID }, { signal: controller.signal })
      .then((result) => {
        if (current !== request) return
        if (!result.data) throw new Error("Canvas response is empty")
        setState({ content: result.data.content, loading: false, error: "" })
      })
      .catch(async (error: unknown) => {
        if (current !== request) return
        // 历史消息可能不在当前分页中，磁盘读取失败时再按消息身份取回持久快照。
        if (state.content === undefined && snapshot() === undefined) {
          const message = await sdk()
            .client.session.message({ sessionID, messageID: props.canvas.messageID }, { signal: controller.signal })
            .catch(() => undefined)
          if (current !== request) return
          const part = message?.data?.parts.find((part) => part.id === props.canvas.partID)
          if (
            part?.type === "tool" &&
            part.tool === "canvas" &&
            part.state.status === "completed" &&
            typeof part.state.metadata.content === "string"
          ) {
            setState("savedContent", part.state.metadata.content)
          }
        }
        setState({ loading: false, error: formatServerError(error, undefined, i18n.t("ui.canvas.loadFailed")) })
      })
  }

  createEffect(() => {
    const client = sdk()
    const sessionID = params.id
    const partID = props.canvas.partID
    const path = props.canvas.path
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      clearTimeout(timer)
      timer = setTimeout(() => void refresh(), 250)
    }
    const edited = (file: string) => {
      if (pathKey(file) === pathKey(path)) schedule()
    }
    const unsubscribers = [
      client.event.on("file.edited", (event) => edited(event.properties.file)),
      client.event.on("file.watcher.updated", (event) => edited(event.properties.file)),
      // 忽略目录或漏收 watcher 事件时，在当前轮结束后再与文件对齐。
      client.event.on("session.status", (event) => {
        if (event.properties.sessionID === sessionID && event.properties.status.type === "idle") schedule()
      }),
    ]
    if (partID) void refresh()
    onCleanup(() => {
      request++
      abort?.abort()
      clearTimeout(timer)
      unsubscribers.forEach((unsubscribe) => unsubscribe())
    })
  })

  const draft = (text: string) => {
    if (!prompt.ready()) return
    const parts = prompt.current()
    const end = parts.reduce((end, part) => ("end" in part ? Math.max(end, part.end) : end), 0)
    const content = `${end ? "\n\n" : ""}${text}`
    // 追问追加到草稿而非直接发送，保留用户已有文字、附件及最终确认权。
    prompt.set([...parts, { type: "text", content, start: end, end: end + content.length }], end + content.length)
    if (!layout.isDesktop()) view().reviewPanel.close()
  }

  const select = () => {
    const selected = window.getSelection()
    if (!selected || !documentRoot?.contains(selected.anchorNode) || !documentRoot.contains(selected.focusNode)) return
    setState("selection", selected.toString().trim().slice(0, 8000))
  }

  const fix = (error: string) => draft(i18n.t("ui.canvas.fixPrompt", { path: props.canvas.path, error }))

  const copy = async () => {
    if (!state.copy || state.copying) return
    const action = state.copy
    setState({ copying: true, copied: false, copyError: "" })
    await action().then(
      () => setState({ copying: false, copied: true }),
      (error: unknown) =>
        setState({ copying: false, copyError: formatServerError(error, undefined, i18n.t("ui.canvas.copyFailed")) }),
    )
  }

  return (
    <div class="flex h-full min-h-0 flex-col bg-background-base">
      <div class="flex flex-wrap items-center gap-1 px-3 py-2">
        <span class="min-w-0 flex-1 truncate text-12-medium text-text-weak" title={props.canvas.path}>
          {props.canvas.title}
        </span>
        <Button
          size="small"
          variant="ghost"
          icon="copy"
          disabled={!state.copy || state.copying}
          onClick={() => void copy()}
        >
          {i18n.t(state.copying ? "ui.canvas.copying" : state.copied ? "ui.canvas.copied" : "ui.canvas.copyImage")}
        </Button>
        <IconButton
          icon="dash"
          variant="ghost"
          aria-label={i18n.t("ui.canvas.zoomOut")}
          disabled={state.zoom <= 60}
          onClick={() => setState("zoom", state.zoom - 10)}
        />
        <Button
          size="small"
          variant="ghost"
          aria-label={i18n.t("ui.canvas.resetZoom")}
          onClick={() => setState("zoom", 100)}
        >
          {state.zoom}%
        </Button>
        <IconButton
          icon="plus-small"
          variant="ghost"
          aria-label={i18n.t("ui.canvas.zoomIn")}
          disabled={state.zoom >= 180}
          onClick={() => setState("zoom", state.zoom + 10)}
        />
        <Button size="small" variant="ghost" disabled={state.loading} onClick={() => void refresh()}>
          {i18n.t("ui.canvas.refresh")}
        </Button>
        <IconButton
          icon="expand"
          variant="ghost"
          aria-label={i18n.t("ui.canvas.expand")}
          onClick={() => setState("expanded", true)}
        />
      </div>
      <Show when={state.copyError}>
        <div role="alert" class="px-4 py-2 text-12-regular text-text-strong">
          {state.copyError}
        </div>
      </Show>
      <Show when={state.error}>
        <div role="status" class="px-4 py-2 text-12-regular text-text-weak">
          <Show when={state.content === undefined && snapshot() !== undefined}>{i18n.t("ui.canvas.snapshot")} </Show>
          {state.error}
        </div>
      </Show>
      <ScrollView
        viewportRef={(el) => {
          documentRoot = el
        }}
        class="flex-1 min-h-0 [&>.scroll-view__viewport]:overscroll-contain"
        onPointerUp={select}
        onKeyUp={select}
      >
        <div style={{ zoom: state.zoom / 100 }}>
          <Show
            when={(state.content ?? snapshot()) !== undefined}
            fallback={<p class="p-4 text-text-weak">{state.loading ? i18n.t("ui.canvas.loading") : state.error}</p>}
          >
            <Suspense fallback={<p class="p-4 text-text-weak">{i18n.t("ui.canvas.loading")}</p>}>
              <CanvasDocument
                content={state.content ?? snapshot() ?? ""}
                title={props.canvas.title}
                onFix={fix}
                fixDisabled={!prompt.ready()}
                onCopyReady={(copy) => setState({ copy, copied: false })}
              />
            </Suspense>
          </Show>
        </div>
      </ScrollView>
      <Show when={state.selection}>
        <div class="flex items-center gap-2 px-3 py-2">
          <span class="flex-1 truncate text-12-regular text-text-weak">{state.selection}</span>
          <Button
            size="small"
            disabled={!prompt.ready()}
            onClick={() =>
              draft(i18n.t("ui.canvas.askPrompt", { path: props.canvas.path, selection: state.selection }))
            }
          >
            {i18n.t("ui.canvas.ask")}
          </Button>
          <IconButton
            icon="close-small"
            aria-label={i18n.t("ui.common.dismiss")}
            onClick={() => setState("selection", "")}
          />
        </div>
      </Show>
      {/* 弹层归当前画布所有，切换会话时一并卸载，不申请 Electron 全屏权限。 */}
      <Root open={state.expanded} onOpenChange={(expanded) => setState("expanded", expanded)}>
        <Portal>
          <Overlay data-component="dialog-overlay" class="z-50" />
          <div class="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
            <Dialog title={props.canvas.title} size="x-large">
              <div class="flex items-center justify-end gap-3 px-5 pb-2">
                <Show when={state.copyError}>
                  <span role="alert" class="text-12-regular text-text-strong">
                    {state.copyError}
                  </span>
                </Show>
                <Button
                  size="small"
                  variant="ghost"
                  icon="copy"
                  disabled={!state.copy || state.copying}
                  onClick={() => void copy()}
                >
                  {i18n.t(
                    state.copying ? "ui.canvas.copying" : state.copied ? "ui.canvas.copied" : "ui.canvas.copyImage",
                  )}
                </Button>
              </div>
              <div class="h-[80vh] overflow-hidden">
                <Suspense fallback={<p class="p-4">{i18n.t("ui.canvas.loading")}</p>}>
                  <CanvasDocument
                    content={state.content ?? snapshot() ?? ""}
                    title={props.canvas.title}
                    onFix={fix}
                    fixDisabled={!prompt.ready()}
                  />
                </Suspense>
              </div>
            </Dialog>
          </div>
        </Portal>
      </Root>
    </div>
  )
}
