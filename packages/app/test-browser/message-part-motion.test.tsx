import { describe, expect, mock, test } from "bun:test"
import { render } from "solid-js/web"
import type { Message, Part as PartType } from "@opencode-ai/sdk/v2"

type AssistantMessage = Extract<Message, { role: "assistant" }>
type TextPart = Extract<PartType, { type: "text" }>

const entered: string[] = []
const motion = await import("@opencode-ai/ui/hooks/gsap-surface")

mock.module("@opencode-ai/ui/hooks/gsap-surface", () => ({
  ...motion,
  animateOutputEnter: (_el: HTMLElement, key: string) => entered.push(key),
}))

const { PART_MAPPING, Part: MessagePart } = await import("@opencode-ai/session-ui/message-part")
PART_MAPPING.text = () => <span>output</span>

const part = (id: string): TextPart => ({
  id,
  sessionID: "session",
  messageID: "message",
  type: "text",
  text: "output",
})

const message = (completed?: number): AssistantMessage => ({
  id: "message",
  sessionID: "session",
  role: "assistant",
  time: completed === undefined ? { created: 1 } : { created: 1, completed },
  parentID: "user",
  modelID: "model",
  providerID: "provider",
  mode: "build",
  agent: "build",
  path: { cwd: "/repo", root: "/repo" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})

describe("message part motion", () => {
  test("does not replay enter motion for completed history without live flag", () => {
    entered.length = 0
    const root = document.createElement("div")
    const dispose = render(() => <MessagePart part={part("historical")} message={message(2)} />, root)

    expect(root.textContent).toBe("output")
    expect(entered).toEqual([])
    dispose()
  })

  // Fork/dup 出的新会话里，未完成 assistant 消息的 part ID 全是新的；
  // 旧的 time.completed 判据会把它们当成实时输出整页重播，live 未标记时必须静默。
  test("does not replay enter motion for unfinished fork history without live flag", () => {
    entered.length = 0
    const root = document.createElement("div")
    const dispose = render(() => <MessagePart part={part("fork-unfinished")} message={message()} />, root)

    expect(root.textContent).toBe("output")
    expect(entered).toEqual([])
    dispose()
  })

  test("keeps enter motion for live assistant output", () => {
    entered.length = 0
    const root = document.createElement("div")
    const dispose = render(() => <MessagePart part={part("live")} message={message()} live />, root)

    expect(root.textContent).toBe("output")
    expect(entered).toEqual(["live"])
    dispose()
  })

  test("live flag wins over completed message", () => {
    entered.length = 0
    const root = document.createElement("div")
    const dispose = render(() => <MessagePart part={part("live-completed")} message={message(2)} live />, root)

    expect(root.textContent).toBe("output")
    expect(entered).toEqual(["live-completed"])
    dispose()
  })
})
