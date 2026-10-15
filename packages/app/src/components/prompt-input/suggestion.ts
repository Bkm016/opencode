import { createEffect, createSignal, on } from "solid-js"
import type { DirectorySDK } from "@/context/sdk"

/**
 * 下一步建议：主会话从忙碌回到空闲后向服务端要一句"用户最可能接着说的话"，
 * 输入框保持为空时显示，Tab 或点击采纳；开始输入、再次开跑、切换会话都会丢弃。
 * 只在本组件见证到 忙碌→空闲 时才请求，刚打开一个已空闲的会话不会触发。
 */
export function createPromptSuggestion(input: {
  sdk: () => DirectorySDK
  sessionID: () => string | undefined
  model: () => { providerID: string; modelID: string } | undefined
  /** 设置开启、普通模式、不是助手栏 */
  enabled: () => boolean
  busy: () => boolean
  /** 输入框里没有任何内容 */
  empty: () => boolean
}) {
  const [text, setText] = createSignal<string>()
  let controller: AbortController | undefined

  const clear = () => {
    controller?.abort()
    controller = undefined
    setText(undefined)
  }

  createEffect(
    on(
      input.busy,
      (busy, prev) => {
        clear()
        if (busy || !prev || !input.enabled()) return
        const id = input.sessionID()
        if (!id) return
        const current = new AbortController()
        controller = current
        void input
          .sdk()
          .client.experimental.prompt.suggest({ sessionID: id, model: input.model() }, { signal: current.signal })
          .then((response) => {
            if (current.signal.aborted || input.sessionID() !== id) return
            const value = response.data?.text?.trim()
            if (value) setText(value)
          })
          .catch(() => {})
      },
      { defer: true },
    ),
  )
  createEffect(on(input.sessionID, clear, { defer: true }))
  createEffect(() => {
    if (!input.enabled() || !input.empty()) clear()
  })

  return {
    /** 当前可显示的建议；输入框有内容时为空 */
    text: () => (input.enabled() && input.empty() ? text() : undefined),
    clear,
  }
}
