import { createStore } from "solid-js/store"
import type { Prompt } from "@/context/prompt"
import type { DirectorySDK } from "@/context/sdk"

type InlinePart = Exclude<Prompt[number], { type: "image" }>

/** 输入框里的纯文本：@文件、@agent 按它们显示的内容拼进去 */
export function promptText(prompt: Prompt) {
  return prompt
    .filter((part): part is InlinePart => part.type !== "image")
    .map((part) => part.content)
    .join("")
}

/**
 * 把改写后的文本还原成输入框的 parts：原文里的 @文件、@agent 在新文本里还能找到的，
 * 继续作为引用；找不到的就当普通文字。图片附件原样保留。
 */
export function rebuildPrompt(text: string, original: Prompt): Prompt {
  const refs = original.filter(
    (part): part is Exclude<InlinePart, { type: "text" }> => part.type !== "text" && part.type !== "image",
  )
  const images = original.filter((part) => part.type === "image")
  const found = refs.map((part) => ({ part, at: -1 })).toSorted((a, b) => b.part.content.length - a.part.content.length)
  const taken: [number, number][] = []
  for (const item of found) {
    let from = 0
    while (from <= text.length) {
      const at = text.indexOf(item.part.content, from)
      if (at === -1 || !item.part.content) break
      const end = at + item.part.content.length
      if (!taken.some(([a, b]) => at < b && end > a)) {
        item.at = at
        taken.push([at, end])
        break
      }
      from = at + 1
    }
  }
  const placed = found.filter((item) => item.at !== -1).toSorted((a, b) => a.at - b.at)

  const parts: Prompt = []
  let cursor = 0
  const pushText = (content: string) => {
    if (!content) return
    parts.push({ type: "text", content, start: cursor, end: cursor + content.length })
    cursor += content.length
  }
  let last = 0
  for (const item of placed) {
    pushText(text.slice(last, item.at))
    const content = item.part.content
    parts.push({ ...item.part, start: cursor, end: cursor + content.length })
    cursor += content.length
    last = item.at + content.length
  }
  pushText(text.slice(last))
  if (parts.length === 0) parts.push({ type: "text", content: "", start: 0, end: 0 })
  return [...parts, ...images]
}

type Enhance = {
  running: boolean
  // 已经收到改写内容（用于区分"等待模型"和"正在输出"两段动画）
  streaming?: boolean
  // 优化前的原文；改写结果还没被改动时可以撤销
  original?: Prompt
  result: string
}

// 模型反问时输入框会被提问弹窗替换掉（组件卸载），状态放在模块里按会话保存，回来后还能接着显示和撤销
const [sessions, setSessions] = createStore<Record<string, Enhance>>({})
const controllers = new Map<string, AbortController>()

export function createPromptEnhance(input: {
  sdk: () => DirectorySDK
  current: () => Prompt
  set: (prompt: Prompt) => void
  sessionID: () => string | undefined
  model: () => { providerID: string; modelID: string } | undefined
  onError: () => void
}) {
  const key = () => input.sessionID() ?? ""
  const state = (): Enhance => sessions[key()] ?? { running: false, result: "" }
  const update = (id: string, next: Partial<Enhance>) =>
    setSessions(id, (prev) => ({ ...(prev ?? { running: false, result: "" }), ...next }))

  const run = async () => {
    const id = key()
    if (state().running) return
    const original = input.current()
    const text = promptText(original).trim()
    if (!text) return
    const controller = new AbortController()
    controllers.set(id, controller)
    const signal = controller.signal
    update(id, { running: true, streaming: false, original, result: "" })
    let output = ""
    try {
      const response = await input
        .sdk()
        .client.experimental.prompt.enhance(
          { text, sessionID: input.sessionID(), model: input.model() },
          { parseAs: "stream", signal },
        )
      const body = response.data as ReadableStream<Uint8Array> | undefined
      if (!body) throw new Error("empty response")
      const reader = body.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        output += decoder.decode(chunk.value, { stream: true })
        if (output.trim() && !sessions[id]?.streaming) update(id, { streaming: true })
        input.set(rebuildPrompt(output.trimStart(), original))
      }
      output = output.trim()
      if (!output) throw new Error("empty result")
      input.set(rebuildPrompt(output, original))
      update(id, { running: false, result: output })
    } catch {
      update(id, { running: false, result: "" })
      // 停止时保留已生成的部分；出错或什么都没生成就还原
      if (signal.aborted && output.trim()) {
        update(id, { result: promptText(input.current()) })
        return
      }
      input.set(original)
      update(id, { original: undefined })
      if (!signal.aborted) input.onError()
    } finally {
      if (controllers.get(id) === controller) controllers.delete(id)
    }
  }

  const stop = () => controllers.get(key())?.abort()

  /** 改写结果没被动过时才能撤销 */
  const canUndo = () => !state().running && !!state().original && promptText(input.current()) === state().result

  const undo = () => {
    if (!canUndo()) return false
    input.set(state().original!)
    update(key(), { original: undefined, result: "" })
    return true
  }

  return {
    running: () => state().running,
    streaming: () => state().running && !!state().streaming,
    canUndo,
    run,
    stop,
    undo,
  }
}
