import { Show, createMemo } from "solid-js"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"

import { SessionContextTab } from "@/components/session"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { gsapEnter } from "@/utils/gsap-motion"
import { SIDE_PANEL_WIDTH_MIN } from "@/pages/session/session-panel-width"
import { useSessionLayout } from "@/pages/session/session-layout"
import type { Sizing } from "@/pages/session/helpers"

export function SessionSidePanel(props: {
  size: Sizing
  stacked?: boolean
  sidePanelSnap?: boolean
  sessionWidth: () => number
  sessionWidthMin: number
  sessionWidthMax: () => number
  onSessionResize: (width: number) => void
  onSessionResizeEnd?: (width: number) => void
  availableWidth: () => number | undefined
}) {
  const layout = useLayout()
  const language = useLanguage()
  const { view } = useSessionLayout()
  const open = createMemo(() => view().reviewPanel.opened())
  const desktopResize = createMemo(() => {
    if (!open()) return false
    if (!layout.isDesktop()) return false
    return props.availableWidth() !== undefined
  })
  const panelWidth = createMemo(() => {
    if (!open()) return "0px"
    if (!layout.isDesktop()) return "100%"
    const available = props.availableWidth()
    if (available === undefined) return "auto"
    return `${Math.max(SIDE_PANEL_WIDTH_MIN, available - props.sessionWidth())}px`
  })
  // 保持 handle 挂载，仅响应尺寸边界变化，避免拖拽时重复重建属性对象。
  const sideSize = createMemo(() => {
    const available = props.availableWidth()
    if (available === undefined) return SIDE_PANEL_WIDTH_MIN
    return Math.max(SIDE_PANEL_WIDTH_MIN, available - props.sessionWidth())
  })
  const sideMin = SIDE_PANEL_WIDTH_MIN
  const sideMax = createMemo(() => {
    const available = props.availableWidth()
    if (available === undefined) return SIDE_PANEL_WIDTH_MIN
    return Math.max(SIDE_PANEL_WIDTH_MIN, available - props.sessionWidthMin)
  })
  const sessionFromSide = (sideWidth: number) => {
    const available = props.availableWidth()
    if (available === undefined) return props.sessionWidth()
    const sessionMin = props.sessionWidthMin
    const sessionMax = props.sessionWidthMax()
    return Math.min(sessionMax, Math.max(sessionMin, available - sideWidth))
  }

  return (
    <Show when={open()}>
      <aside
        id="session-context-panel"
        aria-label={language.t("session.tab.context")}
        aria-hidden={!open()}
        inert={!open()}
        class="relative min-w-0 flex overflow-hidden bg-background-base"
        classList={{
          "h-full shrink-0": !props.stacked,
          "h-full min-h-0": props.stacked,
          "pointer-events-none": !open(),
          "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
            !props.size.active() && !props.sidePanelSnap,
        }}
        style={{ width: panelWidth() }}
      >
        <Show when={desktopResize()}>
          <div class="absolute inset-y-0 left-0 z-30 w-0" onPointerDown={() => props.size.start()}>
            <ResizeHandle
              direction="horizontal"
              edge="start"
              size={sideSize()}
              min={sideMin}
              max={sideMax()}
              onResize={(sideWidth) => props.onSessionResize(sessionFromSide(sideWidth))}
              onResizeEnd={(sideWidth) => props.onSessionResizeEnd?.(sessionFromSide(sideWidth))}
            />
          </div>
        </Show>
        <Show when={open()}>
          <div
            class="size-full min-w-0 flex border-l border-border-weaker-base"
            ref={(element) => gsapEnter(element, { x: 24, y: 0, duration: 0.38 })}
          >
            <div class="relative min-w-0 h-full flex-1 flex flex-col overflow-hidden bg-background-base">
              <div class="h-10 shrink-0 flex items-center justify-between gap-2 px-3 border-b border-border-weaker-base min-w-0">
                <div class="text-14-medium text-text-strong truncate min-w-0">
                  {language.t("session.tab.context")}
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
              </div>
              <div class="flex-1 min-h-0 min-w-0 overflow-hidden">
                <SessionContextTab />
              </div>
            </div>
          </div>
        </Show>
      </aside>
    </Show>
  )
}
