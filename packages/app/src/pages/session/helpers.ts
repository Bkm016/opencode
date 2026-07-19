import { makeEventListener } from "@solid-primitives/event-listener"
import { onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"

export const focusTerminalById = (id: string) => {
  const wrapper = document.getElementById(`terminal-wrapper-${id}`)
  const terminal = wrapper?.querySelector('[data-component="terminal"]')
  if (!(terminal instanceof HTMLElement)) return false

  const textarea = terminal.querySelector("textarea")
  if (textarea instanceof HTMLTextAreaElement) {
    textarea.focus()
    return true
  }

  terminal.focus()
  terminal.dispatchEvent(
    typeof PointerEvent === "function"
      ? new PointerEvent("pointerdown", { bubbles: true, cancelable: true })
      : new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
  )
  return true
}

export const createSizing = () => {
  const [state, setState] = createStore({ active: false })
  let timer: number | undefined

  const stop = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    setState("active", false)
  }

  const start = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    setState("active", true)
  }

  onMount(() => {
    makeEventListener(window, "pointerup", stop)
    makeEventListener(window, "pointercancel", stop)
    makeEventListener(window, "blur", stop)
  })

  onCleanup(() => {
    if (timer !== undefined) clearTimeout(timer)
  })

  return {
    active: () => state.active,
    start,
    touch() {
      start()
      timer = window.setTimeout(stop, 120)
    },
  }
}

export type Sizing = ReturnType<typeof createSizing>
