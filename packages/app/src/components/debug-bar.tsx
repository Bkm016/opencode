import { useBeforeLeave, useIsRouting, useLocation } from "@solidjs/router"
import { batch, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"

type Mem = Performance & {
  memory?: {
    usedJSHeapSize: number
    jsHeapSizeLimit: number
  }
}

type Evt = PerformanceEntry & {
  interactionId?: number
  processingStart?: number
}

type Shift = PerformanceEntry & {
  hadRecentInput: boolean
  value: number
}

type Obs = PerformanceObserverInit & {
  durationThreshold?: number
}

const span = 5000

const ms = (n?: number, d = 0) => {
  if (n === undefined || Number.isNaN(n)) return
  return `${n.toFixed(d)}ms`
}

const time = (n?: number) => {
  if (n === undefined || Number.isNaN(n)) return
  return `${Math.round(n)}`
}

const mb = (n?: number) => {
  if (n === undefined || Number.isNaN(n)) return
  const v = n / 1024 / 1024
  return `${v >= 1024 ? v.toFixed(0) : v.toFixed(1)}MB`
}

const bad = (n: number | undefined, limit: number, low = false) => {
  if (n === undefined || Number.isNaN(n)) return false
  return low ? n < limit : n > limit
}

const session = (path: string) => path.includes("/session")
const navigationDiagnosticKey = "opencode.debug.navigation.pending"

type NavigationDiagnostic = {
  from: string
  to: string
  startedAt: number
}

function readNavigationDiagnostic() {
  try {
    const value = localStorage.getItem(navigationDiagnosticKey)
    return value ? (JSON.parse(value) as NavigationDiagnostic) : undefined
  } catch {
    return undefined
  }
}

const positionKey = "opencode.debug.position"

type DebugPosition = { x: number; y: number }

function readPosition(): DebugPosition | undefined {
  try {
    const value = localStorage.getItem(positionKey)
    if (!value) return
    const parsed = JSON.parse(value) as Partial<DebugPosition>
    if (typeof parsed.x !== "number" || typeof parsed.y !== "number") return
    return { x: parsed.x, y: parsed.y }
  } catch {
    return undefined
  }
}

function writePosition(pos: DebugPosition) {
  try {
    localStorage.setItem(positionKey, JSON.stringify(pos))
  } catch {}
}

// Default offset mirrors the previous CSS (bottom-3 right-3) once measured on
// first mount; until then the store is undefined and the element stays hidden
// to avoid a flash at the top-left origin before placement is resolved.
function clampPosition(pos: DebugPosition, width: number, height: number): DebugPosition {
  const margin = 12
  const maxX = Math.max(margin, window.innerWidth - width - margin)
  const maxY = Math.max(margin, window.innerHeight - height - margin)
  return {
    x: Math.min(Math.max(margin, pos.x), maxX),
    y: Math.min(Math.max(margin, pos.y), maxY),
  }
}

function Cell(props: {
  bad?: boolean
  dim?: boolean
  inline?: boolean
  label: string
  tip: string
  value: string
  wide?: boolean
}) {
  const content = () => (
    <div
      classList={{
        "flex min-w-0 items-center": true,
        "min-h-[20px] w-fit flex-row justify-start gap-1.5 px-1.5 py-0.5 text-left": !!props.inline,
        "justify-center text-center": !props.inline,
        "min-h-[42px] w-full flex-col rounded-[8px] px-0.5 py-1": !props.inline,
        "col-span-2": !!props.wide && !props.inline,
      }}
    >
      <div
        classList={{
          "text-[10px] leading-none font-black uppercase tracking-[0.04em] opacity-70": true,
        }}
      >
        {props.label}
      </div>
      <div
        classList={{
          "uppercase leading-none font-bold tabular-nums": true,
          "text-[11px]": !!props.inline,
          "text-[13px] sm:text-[14px]": !props.inline,
          "text-text-on-critical-base": !!props.bad,
          "opacity-70": !!props.dim,
        }}
      >
        {props.value}
      </div>
    </div>
  )

  if (props.inline) {
    return (
      <TooltipV2 value={props.tip} placement="top">
        {content()}
      </TooltipV2>
    )
  }

  return (
    <Tooltip value={props.tip} placement="top">
      {content()}
    </Tooltip>
  )
}

function FocusCell(props: { active: boolean; inline?: boolean; onClick: () => void }) {
  const content = () => (
    <button
      type="button"
      aria-label="Force focus styles on all interactive elements"
      aria-pressed={props.active}
      classList={{
        "flex min-w-0 items-center font-mono uppercase hover:bg-surface-raised-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-border-focus": true,
        "min-h-[20px] w-fit flex-row justify-start gap-1.5 rounded px-1.5 py-0.5 text-left": !!props.inline,
        "min-h-[42px] w-full flex-col justify-center rounded-[8px] px-0.5 py-1 text-center": !props.inline,
        "bg-surface-raised-base text-text-strong": props.active,
      }}
      onClick={props.onClick}
    >
      <span class="text-[10px] leading-none font-black tracking-[0.04em] opacity-70">FOCUS</span>
      <span classList={{ "leading-none font-bold": true, "text-[11px]": !!props.inline, "text-[13px]": !props.inline }}>
        {props.active ? "ON" : "OFF"}
      </span>
    </button>
  )

  if (props.inline) {
    return (
      <TooltipV2 value="Force focus styles on all interactive elements" placement="top">
        {content()}
      </TooltipV2>
    )
  }

  return (
    <Tooltip value="Force focus styles on all interactive elements" placement="top">
      {content()}
    </Tooltip>
  )
}

export function DebugBar(props: { inline?: boolean } = {}) {
  const language = useLanguage()
  const platform = usePlatform()
  const location = useLocation()
  const routing = useIsRouting()
  const recoveredNavigation = readNavigationDiagnostic()
  const [state, setState] = createStore({
    cls: undefined as number | undefined,
    delay: undefined as number | undefined,
    fps: undefined as number | undefined,
    gap: undefined as number | undefined,
    focus: false,
    collapsed: false,
    heap: {
      limit: undefined as number | undefined,
      used: undefined as number | undefined,
    },
    inp: undefined as number | undefined,
    jank: undefined as number | undefined,
    long: {
      block: undefined as number | undefined,
      count: undefined as number | undefined,
      max: undefined as number | undefined,
    },
    nav: {
      dur: undefined as number | undefined,
      pending: false,
      recovered: !!recoveredNavigation,
      from: recoveredNavigation?.from,
      to: recoveredNavigation?.to,
    },
  })

  // Floating overlay position (only used in the non-inline variant). The
  // default is resolved on mount from the saved position or the previous
  // bottom-right placement; clamped to the viewport on drag and resize.
  let aside: HTMLElement | undefined
  const [position, setPosition] = createSignal<DebugPosition | undefined>(readPosition())
  const [dragging, setDragging] = createSignal(false)

  const resolveDefault = () => {
    const el = aside
    const width = el?.offsetWidth ?? 0
    const height = el?.offsetHeight ?? 0
    return clampPosition({ x: window.innerWidth - width - 12, y: window.innerHeight - height - 12 }, width, height)
  }

  onMount(() => {
    if (props.inline) return
    // If there's no saved position, seed it from the previous bottom-right
    // placement so the first paint is stable rather than stuck at 0,0.
    if (!position()) setPosition(resolveDefault())
    makeEventListener(window, "resize", () => {
      const pos = position()
      if (!pos || !aside) return
      setPosition(clampPosition(pos, aside.offsetWidth, aside.offsetHeight))
    })
  })

  const startDrag = (event: PointerEvent) => {
    if (props.inline) return
    // The whole floating panel is the drag surface so it can be repositioned
    // without requiring a dedicated handle.
    if (event.button !== 0 && event.pointerType === "mouse") return
    const el = aside
    if (!el) return
    const origin = position() ?? resolveDefault()
    const startX = event.clientX
    const startY = event.clientY
    let moved = false

    const move = (ev: PointerEvent) => {
      if (!moved) {
        // 点击与拖动共用一个入口，移动超过阈值后才取消点击语义。
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return
        moved = true
        setDragging(true)
      }
      const next = clampPosition(
        { x: origin.x + ev.clientX - startX, y: origin.y + ev.clientY - startY },
        el.offsetWidth,
        el.offsetHeight,
      )
      setPosition(next)
    }
    const up = () => {
      cleanup()
      if (!moved) return
      setDragging(false)
      const final = position()
      if (final) writePosition(final)
    }
    const cleanup = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", up)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", up)
  }

  const na = () => language.t("debugBar.na").toUpperCase()
  const heap = () => (state.heap.limit ? (state.heap.used ?? 0) / state.heap.limit : undefined)
  const heapv = () => {
    const value = heap()
    if (value === undefined) return na()
    return `${Math.round(value * 100)}%`
  }
  const longv = () => (state.long.count === undefined ? na() : `${time(state.long.block) ?? na()}/${state.long.count}`)
  const navv = () => (state.nav.recovered ? "STUCK" : state.nav.pending ? "..." : (time(state.nav.dur) ?? na()))
  const toggleFocus = async () => {
    if (!platform.setForceFocus) return
    const enabled = !state.focus
    await platform.setForceFocus(enabled)
    setState("focus", enabled)
  }

  onCleanup(() => {
    if (state.focus) void platform.setForceFocus?.(false).catch(() => undefined)
  })

  let prev = ""
  let start = 0
  let init = false
  let one = 0
  let two = 0
  let target = ""

  useBeforeLeave((event) => {
    target = String(event.to)
  })

  createEffect(() => {
    const busy = routing()
    const next = `${location.pathname}${location.search}`

    if (!init) {
      init = true
      prev = next
      return
    }

    if (busy) {
      if (one !== 0) cancelAnimationFrame(one)
      if (two !== 0) cancelAnimationFrame(two)
      one = 0
      two = 0
      if (start !== 0) return
      start = performance.now()
      const diagnostic = { from: prev, to: target, startedAt: Date.now() }
      try {
        localStorage.setItem(navigationDiagnosticKey, JSON.stringify(diagnostic))
      } catch {}
      if (session(prev)) {
        setState("nav", "dur", undefined)
        setState("nav", "pending", true)
      }
      return
    }

    if (start === 0) {
      prev = next
      return
    }

    const at = start
    const from = prev
    start = 0
    prev = next
    target = ""
    try {
      localStorage.removeItem(navigationDiagnosticKey)
    } catch {}

    if (!(session(from) || session(next))) return

    if (one !== 0) cancelAnimationFrame(one)
    if (two !== 0) cancelAnimationFrame(two)
    one = requestAnimationFrame(() => {
      one = 0
      two = requestAnimationFrame(() => {
        two = 0
        setState("nav", "dur", performance.now() - at)
        setState("nav", "pending", false)
      })
    })
  })

  onMount(() => {
    if (recoveredNavigation) console.error("[opencode] Previous navigation did not settle", recoveredNavigation)
    const obs: PerformanceObserver[] = []
    const fps: Array<{ at: number; dur: number }> = []
    const long: Array<{ at: number; dur: number }> = []
    const seen = new Map<number | string, { at: number; delay: number; dur: number }>()
    let hasLong = false
    let poll: number | undefined
    let raf = 0
    let last = 0
    let snap = 0

    const trim = (list: Array<{ at: number; dur: number }>, span: number, at: number) => {
      while (list[0] && at - list[0].at > span) list.shift()
    }

    const syncFrame = (at: number) => {
      trim(fps, span, at)
      const total = fps.reduce((sum, entry) => sum + entry.dur, 0)
      const gap = fps.reduce((max, entry) => Math.max(max, entry.dur), 0)
      const jank = fps.filter((entry) => entry.dur > 32).length
      batch(() => {
        setState("fps", total > 0 ? (fps.length * 1000) / total : undefined)
        setState("gap", gap > 0 ? gap : undefined)
        setState("jank", jank)
      })
    }

    const syncLong = (at = performance.now()) => {
      if (!hasLong) return
      trim(long, span, at)
      const block = long.reduce((sum, entry) => sum + Math.max(0, entry.dur - 50), 0)
      const max = long.reduce((hi, entry) => Math.max(hi, entry.dur), 0)
      setState("long", { block, count: long.length, max })
    }

    const syncInp = (at = performance.now()) => {
      for (const [key, entry] of seen) {
        if (at - entry.at > span) seen.delete(key)
      }
      let delay = 0
      let inp = 0
      for (const entry of seen.values()) {
        delay = Math.max(delay, entry.delay)
        inp = Math.max(inp, entry.dur)
      }
      batch(() => {
        setState("delay", delay > 0 ? delay : undefined)
        setState("inp", inp > 0 ? inp : undefined)
      })
    }

    const syncHeap = () => {
      const mem = (performance as Mem).memory
      if (!mem) return
      setState("heap", { limit: mem.jsHeapSizeLimit, used: mem.usedJSHeapSize })
    }

    const reset = () => {
      fps.length = 0
      long.length = 0
      seen.clear()
      last = 0
      snap = 0
      batch(() => {
        setState("fps", undefined)
        setState("gap", undefined)
        setState("jank", undefined)
        setState("delay", undefined)
        setState("inp", undefined)
        if (hasLong) setState("long", { block: 0, count: 0, max: 0 })
      })
    }

    const watch = (type: string, init: Obs, fn: (entries: PerformanceEntry[]) => void) => {
      if (typeof PerformanceObserver === "undefined") return false
      if (!(PerformanceObserver.supportedEntryTypes ?? []).includes(type)) return false
      const ob = new PerformanceObserver((list) => fn(list.getEntries()))
      try {
        ob.observe(init)
        obs.push(ob)
        return true
      } catch {
        ob.disconnect()
        return false
      }
    }

    if (
      watch("layout-shift", { buffered: true, type: "layout-shift" }, (entries) => {
        const add = entries.reduce((sum, entry) => {
          const item = entry as Shift
          if (item.hadRecentInput) return sum
          return sum + item.value
        }, 0)
        if (add === 0) return
        setState("cls", (value) => (value ?? 0) + add)
      })
    ) {
      setState("cls", 0)
    }

    if (
      watch("longtask", { buffered: true, type: "longtask" }, (entries) => {
        const at = performance.now()
        long.push(...entries.map((entry) => ({ at: entry.startTime, dur: entry.duration })))
        syncLong(at)
      })
    ) {
      hasLong = true
      setState("long", { block: 0, count: 0, max: 0 })
    }

    watch("event", { buffered: true, durationThreshold: 16, type: "event" }, (entries) => {
      for (const raw of entries) {
        const entry = raw as Evt
        if (entry.duration < 16) continue
        const key =
          entry.interactionId && entry.interactionId > 0
            ? entry.interactionId
            : `${entry.name}:${Math.round(entry.startTime)}`
        const prev = seen.get(key)
        const delay = Math.max(0, (entry.processingStart ?? entry.startTime) - entry.startTime)
        seen.set(key, {
          at: entry.startTime,
          delay: Math.max(prev?.delay ?? 0, delay),
          dur: Math.max(prev?.dur ?? 0, entry.duration),
        })
        if (seen.size <= 200) continue
        const first = seen.keys().next().value
        if (first !== undefined) seen.delete(first)
      }
      syncInp()
    })

    const loop = (at: number) => {
      if (document.visibilityState !== "visible") {
        raf = 0
        return
      }

      if (last === 0) {
        last = at
        raf = requestAnimationFrame(loop)
        return
      }

      fps.push({ at, dur: at - last })
      last = at

      if (at - snap >= 250) {
        snap = at
        syncFrame(at)
      }

      raf = requestAnimationFrame(loop)
    }

    const stop = () => {
      if (raf !== 0) cancelAnimationFrame(raf)
      raf = 0
      if (poll === undefined) return
      clearInterval(poll)
      poll = undefined
    }

    const start = () => {
      if (document.visibilityState !== "visible") return
      if (poll === undefined) {
        poll = window.setInterval(() => {
          syncLong()
          syncInp()
          syncHeap()
        }, 1000)
      }
      if (raf !== 0) return
      raf = requestAnimationFrame(loop)
    }

    const vis = () => {
      if (document.visibilityState !== "visible") {
        stop()
        return
      }
      reset()
      start()
    }

    syncHeap()
    start()
    makeEventListener(document, "visibilitychange", vis)

    onCleanup(() => {
      if (one !== 0) cancelAnimationFrame(one)
      if (two !== 0) cancelAnimationFrame(two)
      stop()
      for (const ob of obs) ob.disconnect()
    })
  })

  return (
    <aside
      ref={aside}
      aria-label={language.t("debugBar.ariaLabel")}
      onPointerDown={startDrag}
      onDblClick={() => {
        if (!props.inline) setState("collapsed", (value) => !value)
      }}
      classList={{
        "pointer-events-auto hidden overflow-hidden text-text-strong md:block": true,
        "cursor-grab touch-none select-none": !props.inline,
        "cursor-grabbing": !props.inline && dragging(),
        "mt-[-6px] w-full shrink-0 px-3 py-1": !!props.inline,
        "fixed z-50 w-[308px] max-w-[calc(100vw-1.5rem)] rounded-xl border border-border-base bg-surface-raised-stronger-non-alpha p-0.5 shadow-[var(--shadow-lg-border-base)] sm:w-[324px]":
          !props.inline && !state.collapsed,
        "fixed z-50 flex size-8 items-center justify-center rounded-lg border border-border-base bg-surface-raised-stronger-non-alpha shadow-[var(--shadow-lg-border-base)]":
          !props.inline && state.collapsed,
        "bottom-3 right-3 sm:bottom-4 sm:right-4": !props.inline && !position(),
      }}
      style={!props.inline && position() ? { left: `${position()!.x}px`, top: `${position()!.y}px` } : undefined}
    >
      {state.collapsed && !props.inline && (
        <button
          type="button"
          aria-label={language.t("debugBar.ariaLabel")}
          class="flex size-full flex-col items-center justify-center gap-0.5 text-text-strong outline-none hover:bg-surface-raised-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-border-focus"
        >
          <span class="text-[8px] leading-none font-black tracking-[0.04em] opacity-70">FPS</span>
          <span class="text-[11px] leading-none font-bold tabular-nums">
            {state.fps === undefined ? na() : `${Math.round(state.fps)}`}
          </span>
        </button>
      )}
      <div
        classList={{
          "font-mono": true,
          "gap-[9px]": !!props.inline,
          "gap-px": !props.inline,
          "flex w-full flex-nowrap items-center justify-start": !!props.inline,
          "grid-cols-5": !props.inline,
          grid: !props.inline,
          hidden: !props.inline && state.collapsed,
        }}
      >
        <Cell
          label={language.t("debugBar.nav.label")}
          tip={
            state.nav.recovered
              ? `Previous navigation did not settle: ${state.nav.from ?? "?"} -> ${state.nav.to ?? "?"}`
              : language.t("debugBar.nav.tip")
          }
          value={navv()}
          bad={state.nav.recovered || bad(state.nav.dur, 400)}
          dim={state.nav.dur === undefined && !state.nav.pending && !state.nav.recovered}
          inline={props.inline}
        />
        <Cell
          label={language.t("debugBar.fps.label")}
          tip={language.t("debugBar.fps.tip")}
          value={state.fps === undefined ? na() : `${Math.round(state.fps)}`}
          bad={bad(state.fps, 50, true)}
          dim={state.fps === undefined}
          inline={props.inline}
        />
        <Cell
          label={language.t("debugBar.frame.label")}
          tip={language.t("debugBar.frame.tip")}
          value={time(state.gap) ?? na()}
          bad={bad(state.gap, 50)}
          dim={state.gap === undefined}
          inline={props.inline}
        />
        <Cell
          label={language.t("debugBar.jank.label")}
          tip={language.t("debugBar.jank.tip")}
          value={state.jank === undefined ? na() : `${state.jank}`}
          bad={bad(state.jank, 8)}
          dim={state.jank === undefined}
          inline={props.inline}
        />
        <Cell
          label={language.t("debugBar.long.label")}
          tip={language.t("debugBar.long.tip", { max: ms(state.long.max) ?? na() })}
          value={longv()}
          bad={bad(state.long.block, 200)}
          dim={state.long.count === undefined}
          inline={props.inline}
        />
        <Cell
          label={language.t("debugBar.delay.label")}
          tip={language.t("debugBar.delay.tip")}
          value={time(state.delay) ?? na()}
          bad={bad(state.delay, 100)}
          dim={state.delay === undefined}
          inline={props.inline}
        />
        <Cell
          label={language.t("debugBar.inp.label")}
          tip={language.t("debugBar.inp.tip")}
          value={time(state.inp) ?? na()}
          bad={bad(state.inp, 200)}
          dim={state.inp === undefined}
          inline={props.inline}
        />
        <Cell
          label={language.t("debugBar.cls.label")}
          tip={language.t("debugBar.cls.tip")}
          value={state.cls === undefined ? na() : state.cls.toFixed(2)}
          bad={bad(state.cls, 0.1)}
          dim={state.cls === undefined}
          inline={props.inline}
        />
        <Cell
          label={language.t("debugBar.mem.label")}
          tip={
            state.heap.used === undefined
              ? language.t("debugBar.mem.tipUnavailable")
              : language.t("debugBar.mem.tip", {
                  used: mb(state.heap.used) ?? na(),
                  limit: mb(state.heap.limit) ?? na(),
                })
          }
          value={heapv()}
          bad={bad(heap(), 0.8)}
          dim={state.heap.used === undefined}
          inline={props.inline}
          wide={!platform.setForceFocus}
        />
        {platform.setForceFocus && (
          <FocusCell active={state.focus} inline={props.inline} onClick={() => void toggleFocus()} />
        )}
      </div>
    </aside>
  )
}
