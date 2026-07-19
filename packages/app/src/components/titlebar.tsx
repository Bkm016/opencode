import { createEffect, createMemo, createSignal, onMount, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
import { Button } from "@opencode-ai/ui/button"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"

import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { WindowsAppMenu } from "./windows-app-menu"
import { applyPath, backPath, forwardPath } from "./titlebar-history"
import "./titlebar.css"

type TauriDesktopWindow = {
  startDragging?: () => Promise<void>
  toggleMaximize?: () => Promise<void>
}

type TauriThemeWindow = {
  setTheme?: (theme?: "light" | "dark" | null) => Promise<void>
}

type TauriApi = {
  window?: {
    getCurrentWindow?: () => TauriDesktopWindow
  }
  webviewWindow?: {
    getCurrentWebviewWindow?: () => TauriThemeWindow
  }
}

const tauriApi = () => (window as unknown as { __TAURI__?: TauriApi }).__TAURI__
const currentDesktopWindow = () => tauriApi()?.window?.getCurrentWindow?.()
const currentThemeWindow = () => tauriApi()?.webviewWindow?.getCurrentWebviewWindow?.()
const legacyTitlebarHeight = 40
const minTitlebarZoom = 0.25
const windowsControlsBaseWidth = 138 // 3 native Windows caption buttons at 46px each.

export type TitlebarUpdate = {
  version: () => string | undefined
  installing: () => boolean
  install: () => void
}

export function useTitlebarRightMount() {
  const [mount, setMount] = createSignal<HTMLElement | null>(null)
  onMount(() => setMount(document.getElementById("opencode-titlebar-right")))
  return mount
}

export function Titlebar(props: { update?: TitlebarUpdate }) {
  const layout = useLayout()
  const platform = usePlatform()
  const command = useCommand()
  const language = useLanguage()
  const theme = useTheme()
  const navigate = useNavigate()
  const location = useLocation()
  const params = useParams()
  const isDesktop = layout.isDesktop
  const bottom = createMemo(() => false)

  const mac = createMemo(() => platform.platform === "desktop" && platform.os === "macos")
  const windows = createMemo(() => platform.platform === "desktop" && platform.os === "windows")
  const electronWindows = createMemo(() => windows() && !tauriApi())
  const linux = createMemo(() => platform.platform === "desktop" && platform.os === "linux")
  const web = createMemo(() => platform.platform === "web")
  const zoom = () => platform.webviewZoom?.() ?? 1
  const titlebarZoom = () => (windows() ? Math.max(zoom(), minTitlebarZoom) : zoom())
  const counterZoom = () => (windows() && titlebarZoom() < 1 ? 1 / titlebarZoom() : 1)
  const minHeight = () => {
    const height = legacyTitlebarHeight
    if (mac()) return `${height / zoom()}px`
    if (windows()) return `${height / Math.min(titlebarZoom(), 1)}px`
    return undefined
  }
  const windowsControlsWidth = () => `${windowsControlsBaseWidth / Math.max(titlebarZoom(), 1)}px`

  const [history, setHistory] = createStore({
    stack: [] as string[],
    index: 0,
    action: undefined as "back" | "forward" | undefined,
  })

  const path = () => `${location.pathname}${location.search}${location.hash}`
  const creating = createMemo(() => {
    const route = layout.route()
    if (route.type === "draft" || route.type === "dir-new-sesssion") return true
    if (!params.dir) return false
    if (params.id) return false
    const parts = location.pathname.replace(/\/+$/, "").split("/")
    return parts.at(-1) === "session"
  })

  createEffect(() => {
    const current = path()

    untrack(() => {
      const next = applyPath(history, current)
      if (next === history) return
      setHistory(next)
    })
  })

  const canBack = createMemo(() => history.index > 0)
  const canForward = createMemo(() => history.index < history.stack.length - 1)
  const hasProjects = createMemo(() => layout.projects.list().length > 0)
  const nav = createMemo(() => true)
  const back = () => {
    const next = backPath(history)
    if (!next) return
    setHistory(next.state)
    navigate(next.to)
  }

  const forward = () => {
    const next = forwardPath(history)
    if (!next) return
    setHistory(next.state)
    navigate(next.to)
  }

  command.register(() => [
    {
      id: "common.goBack",
      title: language.t("common.goBack"),
      category: language.t("command.category.view"),
      keybind: "mod+[",
      onSelect: back,
    },
    {
      id: "common.goForward",
      title: language.t("common.goForward"),
      category: language.t("command.category.view"),
      keybind: "mod+]",
      onSelect: forward,
    },
  ])

  const getWin = () => {
    if (platform.platform !== "desktop") return
    return currentDesktopWindow()
  }

  createEffect(() => {
    if (platform.platform !== "desktop") return

    const scheme = theme.colorScheme()
    const value = scheme === "system" ? null : scheme

    const win = currentThemeWindow()
    if (!win?.setTheme) return

    void win.setTheme(value).catch(() => undefined)
  })

  const interactive = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return false

    const selector =
      "button, a, input, textarea, select, option, [role='button'], [role='menuitem'], [contenteditable='true'], [contenteditable='']"

    return !!target.closest(selector)
  }

  const drag = (e: MouseEvent) => {
    if (platform.platform !== "desktop") return
    if (e.buttons !== 1) return
    if (interactive(e.target)) return

    const win = getWin()
    if (!win?.startDragging) return

    e.preventDefault()
    void win.startDragging().catch(() => undefined)
  }

  const maximize = (e: MouseEvent) => {
    if (platform.platform !== "desktop") return
    if (interactive(e.target)) return
    if (e.target instanceof Element && e.target.closest("[data-tauri-decorum-tb]")) return

    const win = getWin()
    if (!win?.toggleMaximize) return

    e.preventDefault()
    void win.toggleMaximize().catch(() => undefined)
  }

  return (
    <header
      classList={{
        "shrink-0 relative flex flex-row": true,
        "h-10 bg-background-base overflow-hidden": true,
        "order-last": bottom(),
      }}
      style={{
        "min-height": minHeight(),
        // Keep native macOS traffic lights clear even when the desktop window is narrow.
        "padding-left": mac() ? `${84 / zoom()}px` : 0,
        width: electronWindows() ? `env(titlebar-area-width, calc(100vw - ${windowsControlsWidth()}))` : undefined,
        "max-width": electronWindows()
          ? `env(titlebar-area-width, calc(100vw - ${windowsControlsWidth()}))`
          : undefined,
        "align-self": electronWindows() ? "flex-start" : undefined,
      }}
      data-tauri-drag-region
      onMouseDown={drag}
      onDblClick={maximize}
    >
        <div class="relative h-full min-h-full w-full" style={{ zoom: counterZoom() }}>
          <div class="flex h-full w-full items-center">
          <div
            data-titlebar-side="left"
            classList={{
              "relative z-10 flex min-w-0 flex-1 items-center": true,
              "pl-2": !mac(),
            }}
          >
            <Show when={windows() || linux()}>
              <WindowsAppMenu command={command} platform={platform} />
            </Show>
            <Show when={!isDesktop() && mac()}>
              <div class="w-10 shrink-0 flex items-center justify-center">
                <IconButton
                  icon="menu"
                  variant="ghost"
                  class="titlebar-icon rounded-md"
                  onClick={layout.mobileSidebar.toggle}
                  aria-label={language.t("sidebar.menu.toggle")}
                  aria-expanded={layout.mobileSidebar.opened()}
                />
              </div>
            </Show>
            <Show when={!isDesktop() && !mac()}>
              <div class="w-[48px] shrink-0 flex items-center justify-center">
                <IconButton
                  icon="menu"
                  variant="ghost"
                  class="titlebar-icon rounded-md"
                  onClick={layout.mobileSidebar.toggle}
                  aria-label={language.t("sidebar.menu.toggle")}
                  aria-expanded={layout.mobileSidebar.opened()}
                />
              </div>
            </Show>
            <div class="flex items-center gap-1 shrink-0">
              <Show when={isDesktop()}>
                <TooltipKeybind
                  class={web() ? "shrink-0 ml-14" : "shrink-0 ml-2"}
                  placement="bottom"
                  title={language.t("command.sidebar.toggle")}
                  keybind={command.keybind("sidebar.toggle")}
                >
                  <Button
                    variant="ghost"
                    class="group/sidebar-toggle titlebar-icon w-8 h-6 p-0 box-border"
                    onClick={layout.sidebar.toggle}
                    aria-label={language.t("command.sidebar.toggle")}
                    aria-expanded={layout.sidebar.opened()}
                  >
                    <Icon size="small" name={layout.sidebar.opened() ? "sidebar-active" : "sidebar"} />
                  </Button>
                </TooltipKeybind>
              </Show>
              <div
                classList={{
                  "items-center shrink-0": true,
                  hidden: !isDesktop(),
                  flex: isDesktop(),
                }}
              >
                <Show when={params.dir}>
                  <div
                    class="flex items-center shrink-0 w-8 mr-1"
                    aria-hidden={layout.sidebar.opened() ? "true" : undefined}
                  >
                    <div
                      class="transition-opacity"
                      classList={{
                        "opacity-100 duration-120 ease-out": !layout.sidebar.opened(),
                        "opacity-0 duration-120 ease-in delay-0 pointer-events-none": layout.sidebar.opened(),
                      }}
                    >
                      <TooltipKeybind
                        placement="bottom"
                        title={language.t("command.session.new")}
                        keybind={command.keybind("session.new")}
                        openDelay={800}
                      >
                        <Button
                          variant="ghost"
                          class="titlebar-icon w-8 h-6 p-0 box-border"
                          disabled={layout.sidebar.opened()}
                          tabIndex={layout.sidebar.opened() ? -1 : undefined}
                          onClick={() => {
                            if (!params.dir) return
                            navigate(`/${params.dir}/session`)
                          }}
                          aria-label={language.t("command.session.new")}
                          aria-current={creating() ? "page" : undefined}
                        >
                          <IconV2 name="edit" size="small" />
                        </Button>
                      </TooltipKeybind>
                    </div>
                  </div>
                </Show>
                <div
                  class="flex items-center shrink-0"
                  classList={{
                    "-translate-x-[36px]": layout.sidebar.opened() && !!params.dir,
                    "duration-180 ease-out": !layout.sidebar.opened(),
                    "duration-180 ease-in": layout.sidebar.opened(),
                  }}
                >
                  <Show when={hasProjects() && nav()}>
                    <div class="flex items-center gap-0 transition-transform">
                      <Tooltip placement="bottom" value={language.t("common.goBack")} openDelay={800}>
                        <Button
                          variant="ghost"
                          icon="chevron-left"
                          class="titlebar-icon w-6 h-6 p-0 box-border"
                          disabled={!canBack()}
                          onClick={back}
                          aria-label={language.t("common.goBack")}
                        />
                      </Tooltip>
                      <Tooltip placement="bottom" value={language.t("common.goForward")} openDelay={800}>
                        <Button
                          variant="ghost"
                          icon="chevron-right"
                          class="titlebar-icon w-6 h-6 p-0 box-border"
                          disabled={!canForward()}
                          onClick={forward}
                          aria-label={language.t("common.goForward")}
                        />
                      </Tooltip>
                    </div>
                  </Show>
                  <div id="opencode-titlebar-left" class="flex items-center gap-3 min-w-0 px-2" />
                  <ChannelIndicator />
                </div>
              </div>
            </div>
          </div>

          <div
            data-titlebar-side="right"
            classList={{
              "relative z-10 flex min-w-0 flex-1 items-center justify-end": true,
              "pr-2": !windows(),
            }}
            data-tauri-drag-region
            onMouseDown={drag}
          >
            <div id="opencode-titlebar-right" class="flex items-center gap-1 shrink-0 justify-end" />
            <Show when={windows()}>
              <div data-tauri-decorum-tb class="flex flex-row" />
            </Show>
          </div>
          </div>

          <div class="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
            <div
              id="opencode-titlebar-center"
              class="pointer-events-auto flex min-w-0 max-w-full justify-center"
            />
          </div>
        </div>

    </header>
  )
}

function ChannelIndicator() {
  return (
    <>
      {["beta", "dev"].includes(import.meta.env.VITE_OPENCODE_CHANNEL) && (
        <div class="bg-icon-interactive-base text-[#FFF] font-medium px-2 rounded-sm uppercase font-mono">
          {import.meta.env.VITE_OPENCODE_CHANNEL.toUpperCase()}
        </div>
      )}
    </>
  )
}
