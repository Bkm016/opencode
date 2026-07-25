import { createEffect, onCleanup, Show, type ValidComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"

const MAX_LATENCY = 80
const MIN_SPEED = 0.02

export const Typewriter = <T extends ValidComponent = "p">(props: { text?: string; class?: string; as?: T }) => {
  const [store, setStore] = createStore({
    typing: false,
    displayed: "",
    cursor: true,
  })

  const state = {
    target: "",
    index: 0,
    lastArrivalTime: 0,
    rate: 0.03,
    raf: 0,
    settleTimer: 0,
    lastFrame: 0,
  }

  createEffect(() => {
    const text = props.text ?? ""
    const now = performance.now()
    const previous = state.target
    const previousLength = previous.length
    state.target = text

    if (!text) {
      setStore({ typing: false, displayed: "", cursor: false })
      state.index = 0
      state.lastArrivalTime = 0
      state.rate = 0.03
      stop()
      return
    }

    if (!text.startsWith(previous)) {
      state.index = 0
      setStore("displayed", "")
      state.rate = 0.03
    } else if (text.length > previousLength && state.lastArrivalTime > 0) {
      const delta = text.length - previousLength
      const elapsed = now - state.lastArrivalTime
      if (elapsed > 0) {
        const measured = delta / elapsed
        state.rate = state.rate * 0.6 + measured * 0.4
      }
    }

    state.lastArrivalTime = now

    setStore("typing", true)
    setStore("cursor", true)

    if (!state.raf) {
      state.raf = requestAnimationFrame(loop)
    }

    onCleanup(stop)
  })

  function stop() {
    if (state.raf) cancelAnimationFrame(state.raf)
    if (state.settleTimer) clearTimeout(state.settleTimer)
    state.raf = 0
    state.settleTimer = 0
  }

  function loop(t: number) {
    const target = state.target
    if (!target) {
      state.raf = 0
      return
    }

    const previous = state.index
    const behind = target.length - previous
    if (behind <= 0) {
      state.index = target.length
      setStore("displayed", target)
      setStore("typing", false)
      if (!state.settleTimer) {
        state.settleTimer = window.setTimeout(() => setStore("cursor", false), 2000)
      }
      state.raf = 0
      return
    }

    if (state.lastFrame === 0) state.lastFrame = t
    const dt = Math.min(t - state.lastFrame, 100)
    state.lastFrame = t
    if (dt <= 0) {
      state.raf = requestAnimationFrame(loop)
      return
    }

    const speed = Math.max(state.rate * 1.25, behind / MAX_LATENCY, MIN_SPEED)
    const next = Math.min(target.length, previous + speed * dt)
    state.index = next
    if (Math.floor(next) !== Math.floor(previous)) {
      setStore("displayed", target.slice(0, Math.floor(next)))
    }

    state.raf = requestAnimationFrame(loop)
  }

  return (
    <Dynamic component={props.as || "p"} class={props.class}>
      {store.displayed}
      <Show when={store.cursor}>
        <span classList={{ "blinking-cursor": !store.typing }}>│</span>
      </Show>
    </Dynamic>
  )
}
