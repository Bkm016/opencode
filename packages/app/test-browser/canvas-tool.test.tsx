import { afterEach, describe, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { CanvasTool } from "@opencode-ai/session-ui/canvas-tool"
import { Part } from "@opencode-ai/session-ui/message-part"
import { DataProvider } from "@opencode-ai/session-ui/context/data"
import { CanvasContext, CanvasLinks, type CanvasReference } from "@opencode-ai/session-ui/context/canvas"
import { createMarkdownParser, MarkedProvider } from "@opencode-ai/ui/context/marked"
import { sanitizeMarkdown } from "@opencode-ai/session-ui/markdown-cache"
import type { AssistantMessage, TextPart, ToolPart, UserMessage } from "@opencode-ai/sdk/v2"
import { Timeline } from "@/pages/session/timeline/rows"

const dispose: Array<() => void> = []

afterEach(() => dispose.splice(0).forEach((cleanup) => cleanup()))

describe("canvas tool", () => {
  test("completed turns show canvas references between answer body and actions without response links", async () => {
    const user: UserMessage = {
      id: "user",
      sessionID: "session-one",
      role: "user",
      time: { created: 1 },
      model: { providerID: "test", modelID: "test" },
    }
    const assistant: AssistantMessage = {
      id: "assistant",
      sessionID: user.sessionID,
      role: "assistant",
      parentID: user.id,
      time: { created: 2, completed: 3 },
      modelID: "test",
      providerID: "test",
      mode: "build",
      agent: "build",
      path: { cwd: "/project", root: "/project" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    const tool = (id: string, path: string, title: string): ToolPart => ({
      id,
      sessionID: user.sessionID,
      messageID: assistant.id,
      type: "tool",
      tool: "canvas",
      callID: id,
      state: {
        status: "completed",
        input: { path },
        title,
        output: "Opened",
        metadata: { path, title },
        time: { start: 2, end: 3 },
      },
    })
    const failed: ToolPart = {
      ...tool("failed", "/project/failed.md", "Failed canvas"),
      state: { status: "error", input: {}, error: "Missing file", time: { start: 2, end: 3 } },
    }
    const parts: Record<string, (ToolPart | TextPart)[]> = {
      assistant: [
        tool("old", "/project/ride.md", "Old title"),
        tool("second", "/project/gear.md", "Equipment"),
        tool("latest", "/project/ride.md", "Coastal ride"),
        failed,
        { ...tool("foreign", "/project/foreign.md", "Foreign canvas"), sessionID: "another-session" },
      ],
      answer: [
        { id: "text", sessionID: user.sessionID, messageID: "answer", type: "text", text: "Explanation ready." },
      ],
    }
    const messages = [assistant, { ...assistant, id: "answer" }]
    const getParts = (id: string) => parts[id] ?? []
    const active = Timeline.constructMessageRows(user, getParts, messages, 0, true, "busy", true)
    expect(
      active.some((row) => row._tag === "CanvasSummary" || (row._tag === "AssistantPart" && row.canvases?.length)),
    ).toBe(false)

    const rows = Timeline.constructMessageRows(user, getParts, messages, 0, true, "idle", false)
    expect(rows.map((row) => row._tag)).toEqual(["UserMessage", "ProcessSummary", "AssistantPart"])
    const summary = rows.find((row) => row._tag === "AssistantPart")!
    expect(summary.canvases?.map((canvas) => canvas.partID)).toEqual(["latest", "second"])
    const opened: Array<{ sessionID: string; canvas: CanvasReference }> = []
    const root = document.createElement("div")
    document.body.append(root)
    const cleanup = render(
      () => (
        <CanvasContext.Provider value={(sessionID, canvas) => opened.push({ sessionID, canvas })}>
          <DataProvider
            directory="/project"
            data={{
              session: [],
              session_status: {},
              session_diff: {},
              message: { [user.sessionID]: [user, ...messages] },
              part: parts,
            }}
          >
            <MarkedProvider>
              <Part part={parts.answer![0]!} message={messages[1]!} canvases={summary.canvases} />
            </MarkedProvider>
          </DataProvider>
        </CanvasContext.Provider>
      ),
      root,
    )
    dispose.push(() => {
      cleanup()
      root.remove()
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const body = root.querySelector('[data-slot="text-part-body"]')!
    const references = root.querySelector('[data-component="canvas-summary"]')!
    const actions = root.querySelector('[data-slot="text-part-copy-wrapper"]')!
    expect(body.textContent).toContain("Explanation ready.")
    expect(body.nextElementSibling).toBe(references)
    expect(references.nextElementSibling).toBe(actions)
    expect(actions.querySelector('[data-slot="text-part-meta"]')?.textContent).toContain("test")
    const buttons = references.querySelectorAll("button")
    expect(Array.from(buttons, (button) => button.textContent)).toEqual(["Coastal ride", "Equipment"])
    buttons[0]!.click()
    buttons[1]!.click()
    expect(opened.map((item) => [item.sessionID, item.canvas.partID, item.canvas.path])).toEqual([
      ["session-one", "latest", "/project/ride.md"],
      ["session-one", "second", "/project/gear.md"],
    ])

    // 无最终正文仍保留成功产物入口；只有失败调用时不生成引用。
    parts.answer = []
    expect(Timeline.constructMessageRows(user, getParts, messages, 0, false, "idle", false).at(-1)?._tag).toBe(
      "CanvasSummary",
    )
    parts.assistant = [failed]
    expect(
      Timeline.constructMessageRows(user, getParts, messages, 0, false, "idle", false).some(
        (row) => row._tag === "CanvasSummary",
      ),
    ).toBe(false)
  })

  test("historical final-answer links still open the latest successful canvas", async () => {
    const path = "C:/project/海岸 骑行 (二) #1&2.md"
    const completed: ToolPart = {
      id: "part-one",
      messageID: "message-one",
      sessionID: "session-one",
      type: "tool",
      tool: "canvas",
      callID: "call-one",
      state: {
        status: "completed",
        input: { path },
        output: "Opened",
        title: "Coastal ride",
        metadata: { path, title: "Coastal ride" },
        time: { start: 1, end: 2 },
      },
    }
    const latest: ToolPart = { ...completed, id: "part-two", messageID: "message-two" }
    const failed: ToolPart = {
      ...completed,
      id: "part-failed",
      state: { status: "error", input: { path }, error: "Denied", time: { start: 3, end: 4 } },
    }
    const [sessionID, setSessionID] = createSignal("session-one")
    const [parts, setParts] = createSignal<(ToolPart | TextPart)[]>([completed, latest, failed])
    const opened: Array<{ sessionID: string; canvas: CanvasReference }> = []
    const unavailable: string[] = []
    const html = sanitizeMarkdown(
      await createMarkdownParser({}).parse(
        `Opened [**Coastal ride**](#canvas?sessionID=session-one&path=${encodeURIComponent(path)}). [Docs](https://example.com)`,
      ),
    )
    const root = document.createElement("div")
    document.body.append(root)
    const cleanup = render(
      () => (
        <CanvasContext.Provider value={(sessionID, canvas) => opened.push({ sessionID, canvas })}>
          <CanvasLinks sessionID={sessionID()} parts={parts} onUnavailable={() => unavailable.push("unavailable")}>
            <div innerHTML={html} />
          </CanvasLinks>
        </CanvasContext.Provider>
      ),
      root,
    )
    dispose.push(() => {
      cleanup()
      root.remove()
    })

    const anchor = root.querySelector("a")!
    const click = new MouseEvent("click", { bubbles: true, cancelable: true })
    anchor.querySelector("strong")!.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    expect(opened).toEqual([
      {
        sessionID: "session-one",
        canvas: { partID: "part-two", messageID: "message-two", path, title: "Coastal ride" },
      },
    ])

    // 切换会话后，旧链接不能借用同路径的新会话权限。
    setSessionID("session-two")
    setParts([{ ...latest, sessionID: "session-two" }])
    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    expect(opened.length).toBe(1)
    expect(unavailable.length).toBe(1)

    setSessionID("session-one")
    setParts([failed])
    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    expect(opened.length).toBe(1)
    expect(unavailable.length).toBe(2)

    anchor.setAttribute("href", "#canvas?path=missing")
    const invalid = new MouseEvent("click", { bubbles: true, cancelable: true })
    anchor.dispatchEvent(invalid)
    expect(invalid.defaultPrevented).toBe(true)
    expect(unavailable.length).toBe(3)

    const external = root.querySelectorAll("a")[1]!
    const normal = new MouseEvent("click", { bubbles: true, cancelable: true })
    // 在目标处阻止真实导航，同时观察上游捕获阶段是否误吞普通外链。
    external.addEventListener(
      "click",
      (event) => {
        expect(event.defaultPrevented).toBe(false)
        event.preventDefault()
      },
      { once: true },
    )
    external.dispatchEvent(normal)
    expect(unavailable.length).toBe(3)
  })

  test("only completed tools open their document in the host", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const [status, setStatus] = createSignal("running")
    const opened: Array<{ sessionID: string; canvas: CanvasReference }> = []
    const cleanup = render(
      () => (
        <CanvasContext.Provider value={(sessionID, canvas) => opened.push({ sessionID, canvas })}>
          <CanvasTool
            tool="canvas"
            sessionID="session-one"
            partID="part-one"
            messageID="message-one"
            status={status()}
            input={{ path: "explanation.md" }}
            metadata={{ path: "/project/explanation.md", title: "Request lifecycle" }}
          />
        </CanvasContext.Provider>
      ),
      root,
    )
    dispose.push(() => {
      cleanup()
      root.remove()
    })

    expect(root.textContent).toContain("Opening canvas")
    expect(
      Array.from(root.querySelectorAll("button")).find((button) => button.textContent?.includes("Open canvas")),
    ).toBeUndefined()

    setStatus("completed")
    const button = Array.from(root.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Open canvas"),
    )
    expect(button).toBeDefined()
    button!.click()
    expect(opened).toEqual([
      {
        sessionID: "session-one",
        canvas: {
          partID: "part-one",
          messageID: "message-one",
          path: "/project/explanation.md",
          title: "Request lifecycle",
        },
      },
    ])
  })

  test("failed tools retain the error without an open action", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const cleanup = render(
      () => (
        <CanvasTool
          tool="canvas"
          status="error"
          input={{ path: "missing.md" }}
          metadata={{}}
          error="File not found: missing.md"
          open
        />
      ),
      root,
    )
    dispose.push(() => {
      cleanup()
      root.remove()
    })

    expect(root.textContent).toContain("Canvas failed")
    expect(root.querySelector('[role="alert"]')?.textContent).toBe("File not found: missing.md")
    expect(
      Array.from(root.querySelectorAll("button")).find((button) => button.textContent?.includes("Open canvas")),
    ).toBeUndefined()
  })
})
