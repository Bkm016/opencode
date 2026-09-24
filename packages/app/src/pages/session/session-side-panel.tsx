import { Show, createMemo } from "solid-js"
import { Portal } from "solid-js/web"
import { Button } from "@opencode-ai/ui/button"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"

import { SessionContextTab } from "@/components/session"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useTitlebarMobileMount } from "@/components/titlebar"
import { gsapEnter } from "@/utils/gsap-motion"
import { useSessionLayout } from "@/pages/session/session-layout"
import type { Sizing } from "@/pages/session/helpers"
import { SessionCanvasPanel } from "./session-canvas-panel"

const TAB_CLASS = "text-text-weak aria-pressed:text-text-strong aria-pressed:bg-surface-raised-base-active"

export function SessionSidePanel(props: {
  size: Sizing
  width: () => number
  widthMin: number
  widthMax: () => number
  onResize: (width: number) => void
  onResizeEnd?: (width: number) => void
}) {
  const layout = useLayout()
  const mobileMount = useTitlebarMobileMount()
  const language = useLanguage()
  const i18n = useI18n()
  const { view, sessionKey } = useSessionLayout()
  const canvasKey = createMemo(() => {
    const canvas = view().canvas.get()
    return canvas && view().canvas.active() ? `${sessionKey()}:${canvas.partID}` : undefined
  })
  const open = createMemo(() => view().reviewPanel.opened())

  const tabs = () => (
    <>
      <div class="flex min-w-0 items-center gap-1">
        <Button
          size="small"
          variant="ghost"
          class={TAB_CLASS}
          aria-pressed={!view().canvas.active()}
          onClick={() => view().canvas.showContext()}
        >
          {language.t("session.tab.context")}
        </Button>
        <Show when={view().canvas.get()}>
          {(canvas) => (
            <Button
              size="small"
              variant="ghost"
              class={TAB_CLASS}
              aria-pressed={view().canvas.active()}
              onClick={() => view().canvas.open(canvas())}
            >
              {i18n.t("ui.canvas.title")}
            </Button>
          )}
        </Show>
      </div>
      <IconButton
        icon="close-small"
        variant="ghost"
        class="shrink-0"
        aria-label={language.t("common.closeTab")}
        onClick={() => {
          view().reviewPanel.close()
        }}
      />
    </>
  )

  return (
    <Show when={open()}>
      {/* 抽屉浮在正文之上：桌面端靠右、可拖宽；手机端铺满整屏。 */}
      <aside
        id="session-context-panel"
        ref={(element) => gsapEnter(element, { x: 32, y: 0, duration: 0.32 })}
        aria-label={view().canvas.active() ? i18n.t("ui.canvas.title") : language.t("session.tab.context")}
        class="absolute z-40 min-w-0 flex bg-background-base"
        classList={{
          // 桌面：与窗口边缘留出间距的浮动卡片；手机：铺满整屏。
          "top-2 right-2 bottom-2 rounded-xl shadow-[var(--shadow-lg-border-base)]": layout.isDesktop(),
          "inset-0": !layout.isDesktop(),
        }}
        style={{ width: layout.isDesktop() ? `${props.width()}px` : undefined }}
      >
        <Show when={layout.isDesktop()}>
          <div class="absolute inset-y-0 left-0 z-30 w-0" onPointerDown={() => props.size.start()}>
            <ResizeHandle
              direction="horizontal"
              edge="start"
              size={props.width()}
              min={props.widthMin}
              max={props.widthMax()}
              onResize={props.onResize}
              onResizeEnd={props.onResizeEnd}
            />
          </div>
        </Show>
        <Show when={open()}>
          <div class="size-full min-w-0 flex rounded-[inherit]">
            <div class="relative min-w-0 h-full flex-1 flex flex-col overflow-hidden rounded-[inherit] bg-background-base">
              <Show
                when={layout.isDesktop()}
                fallback={
                  <Show when={mobileMount()}>
                    {(mount) => (
                      // 手机：Context / Canvas 切换与关闭按钮并入全局标题栏，面板本身少占一行。
                      <Portal mount={mount()}>
                        <div class="flex h-full min-w-0 flex-1 items-center justify-between gap-2 pr-1">{tabs()}</div>
                      </Portal>
                    )}
                  </Show>
                }
              >
                <div class="h-11 shrink-0 flex items-center justify-between gap-2 pl-2 pr-1.5 min-w-0 border-b border-border-weaker-base">
                  {tabs()}
                </div>
              </Show>
              <div class="flex-1 min-h-0 min-w-0 overflow-hidden">
                <Show when={canvasKey()} keyed fallback={<SessionContextTab />}>
                  {(_key) => {
                    const canvas = { ...view().canvas.get()! }
                    return <SessionCanvasPanel canvas={canvas} />
                  }}
                </Show>
              </div>
            </div>
          </div>
        </Show>
      </aside>
    </Show>
  )
}
