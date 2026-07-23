import { useBeforeLeave, useIsRouting, useLocation } from "@solidjs/router"
import { createEffect, onCleanup, onMount } from "solid-js"

const storageKey = "opencode.diagnostics.navigation"
const stuckDelay = 5_000

type Attempt = {
  id: number
  phase: "intent" | "before-leave" | "routing"
  from: string
  to: string
  current: string
  startedAt: number
  target?: string
}

function errorDetails(error: unknown) {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack }
  return { message: String(error) }
}

function log(name: string, details: object) {
  console.error(`[navigation-diagnostic] ${name} ${JSON.stringify(details)}`)
}

export function NavigationDiagnostics() {
  const location = useLocation()
  const routing = useIsRouting()
  const path = () => `${location.pathname}${location.search}${location.hash}`
  let sequence = 0
  let attempt: Attempt | undefined
  let stuckTimer: ReturnType<typeof setTimeout> | undefined
  let intentTimer: ReturnType<typeof setTimeout> | undefined
  let resizeErrors = 0
  let resizeTimer: ReturnType<typeof setTimeout> | undefined

  const persist = () => {
    // 硬刷新后仍保留未完成阶段，下一次导出日志时可还原卡住位置。
    try {
      if (attempt) localStorage.setItem(storageKey, JSON.stringify(attempt))
      else localStorage.removeItem(storageKey)
    } catch {}
  }

  const snapshot = () => ({
    attempt,
    current: path(),
    activeElement:
      document.activeElement instanceof HTMLElement
        ? {
            tag: document.activeElement.tagName,
            role: document.activeElement.getAttribute("role"),
            href: document.activeElement instanceof HTMLAnchorElement ? document.activeElement.href : undefined,
          }
        : undefined,
    visibility: document.visibilityState,
    online: navigator.onLine,
  })

  const armStuckTimer = () => {
    if (stuckTimer) clearTimeout(stuckTimer)
    stuckTimer = setTimeout(() => log("navigation-stuck", snapshot()), stuckDelay)
  }

  const begin = (phase: Attempt["phase"], to: string, target?: string) => {
    if (intentTimer) clearTimeout(intentTimer)
    if (stuckTimer) clearTimeout(stuckTimer)
    attempt = {
      id: ++sequence,
      phase,
      from: path(),
      to,
      current: path(),
      startedAt: Date.now(),
      target,
    }
    persist()
    if (phase !== "intent") armStuckTimer()
  }

  useBeforeLeave((event) => {
    begin("before-leave", String(event.to), attempt?.target)
  })

  createEffect(() => {
    const busy = routing()
    const current = path()
    if (busy) {
      if (!attempt) begin("routing", current)
      if (attempt) {
        attempt.phase = "routing"
        attempt.current = current
        persist()
      }
      armStuckTimer()
      return
    }
    if (!attempt || attempt.phase === "intent") return
    if (stuckTimer) clearTimeout(stuckTimer)
    stuckTimer = undefined
    attempt = undefined
    persist()
  })

  onMount(() => {
    try {
      const previous = localStorage.getItem(storageKey)
      if (previous) log("previous-navigation-did-not-settle", { attempt: JSON.parse(previous), current: path() })
    } catch {}

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      if (!(event.target instanceof Element)) return
      const link = event.target.closest<HTMLAnchorElement>('a[href*="/session"]')
      if (!link) return
      const destination = new URL(link.href, window.location.href)
      if (`${destination.pathname}${destination.search}${destination.hash}` === path()) return
      begin("intent", link.getAttribute("href") ?? link.href, link.getAttribute("data-slot") ?? link.tagName)
      intentTimer = setTimeout(() => {
        if (attempt?.phase !== "intent") return
        log("session-click-did-not-reach-router", snapshot())
      }, 1_000)
    }
    const onError = (event: ErrorEvent) => {
      if (event.message.startsWith("ResizeObserver loop")) {
        // 合并浏览器重复报错，避免诊断本身进一步放大日志量。
        resizeErrors++
        if (resizeTimer) return
        resizeTimer = setTimeout(() => {
          log("resize-observer-errors", { count: resizeErrors, ...snapshot() })
          resizeErrors = 0
          resizeTimer = undefined
        }, 5_000)
        return
      }
      log("window-error", {
        error: errorDetails(event.error ?? event.message),
        filename: event.filename,
        line: event.lineno,
        column: event.colno,
        ...snapshot(),
      })
    }
    const onRejection = (event: PromiseRejectionEvent) => {
      log("unhandled-rejection", { error: errorDetails(event.reason), ...snapshot() })
    }

    window.addEventListener("pointerdown", onPointerDown, true)
    window.addEventListener("error", onError)
    window.addEventListener("unhandledrejection", onRejection)
    onCleanup(() => {
      window.removeEventListener("pointerdown", onPointerDown, true)
      window.removeEventListener("error", onError)
      window.removeEventListener("unhandledrejection", onRejection)
    })
  })

  onCleanup(() => {
    if (stuckTimer) clearTimeout(stuckTimer)
    if (intentTimer) clearTimeout(intentTimer)
    if (resizeTimer) clearTimeout(resizeTimer)
  })

  return null
}
