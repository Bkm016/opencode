import { Marked, type Tokens } from "marked"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import "./markdown-diagram.css"

const parser = new Marked()
const mounted = new WeakMap<Element, { source: string; dispose: () => void }>()

export function disposeMarkdownDiagrams(root: Element) {
  for (const element of [root, ...root.querySelectorAll('[data-component="markdown-diagram"]')]) {
    mounted.get(element)?.dispose()
    mounted.delete(element)
  }
}

// 使用原始 Markdown 的语言标识，不依赖 Shiki 或原生解析器是否保留 language class。
export function decorateMarkdownDiagrams(
  root: HTMLElement,
  source: string,
  labels: { loading: string; source: string; preview: string; zoomIn: string; zoomOut: string; resetView: string },
) {
  if (!/(?:`{3,}|~{3,})\s*(?:mermaid|vega-lite)\b/i.test(source)) return
  const codes: Tokens.Code[] = []
  parser.walkTokens(parser.lexer(source), (token) => {
    if (token.type === "code") codes.push(token as Tokens.Code)
  })
  const blocks = Array.from(root.querySelectorAll("pre"))
  codes.forEach((token, index) => {
    const language = token.lang?.trim().split(/\s+/, 1)[0]?.toLowerCase()
    if (language !== "mermaid" && language !== "vega-lite") return
    const fence = token.raw.match(/^\s*(`{3,}|~{3,})/)?.[1]
    // 未闭合的流式/中断代码块仍展示源码，不让补全器猜测的 JSON 或 Mermaid 进入渲染器。
    if (
      !fence ||
      !new RegExp(`^${fence[0]}{${fence.length},}\\s*$`).test(token.raw.trimEnd().split("\n").at(-1)?.trim() ?? "")
    )
      return
    const pre = blocks[index]
    if (!pre) return
    const old = pre.closest<HTMLElement>('[data-component="markdown-diagram"]')
    const identity = `${language}\0${token.text}`
    if (old && mounted.get(old)?.source === identity) return
    if (old) disposeMarkdownDiagrams(old)
    const wrapper = pre.closest<HTMLElement>('[data-component="markdown-code"]') ?? pre
    const host = document.createElement("div")
    host.dataset.component = "markdown-diagram"
    const output = document.createElement("div")
    output.dataset.slot = "markdown-diagram-output"
    const status = document.createElement("p")
    status.setAttribute("role", "status")
    status.textContent = labels.loading
    const toggle = document.createElement("div")
    toggle.dataset.slot = "markdown-diagram-toggle"
    const [sourceVisible, setSourceVisible] = createSignal(false)
    const sourceView = document.createElement("div")
    sourceView.dataset.slot = "markdown-diagram-source"
    // 两种视图互斥显示，切换不重新绘图，主题重绘也不重置用户正在查看的源码。
    const showSource = (show: boolean) => {
      sourceView.hidden = !show
      output.hidden = show
      setSourceVisible(show)
    }
    // 平移缩放只作用于 Mermaid 流程图等结构图；Vega-Lite 数据图保持静态展示。
    const pannable = language === "mermaid"
    const view = { x: 0, y: 0, scale: 1 }
    const applyView = () => {
      const stage = output.firstElementChild
      if (stage instanceof HTMLElement)
        stage.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`
    }
    // 以视口内某点为锚缩放：保持该点下的图内容位置不变。
    const zoomAt = (factor: number, px: number, py: number) => {
      const scale = Math.min(8, Math.max(0.25, view.scale * factor))
      view.x = px - (scale * (px - view.x)) / view.scale
      view.y = py - (scale * (py - view.y)) / view.scale
      view.scale = scale
      applyView()
    }
    const zoomCenter = (factor: number) => zoomAt(factor, output.clientWidth / 2, output.clientHeight / 2)
    const resetView = () => {
      Object.assign(view, { x: 0, y: 0, scale: 1 })
      applyView()
    }
    const disposeToggle = render(
      () => (
        <>
          {pannable && !sourceVisible() && (
            <>
              <TooltipV2 placement="top" value={labels.zoomOut}>
                <IconButtonV2
                  type="button"
                  size="normal"
                  variant="ghost-muted"
                  aria-label={labels.zoomOut}
                  icon={<Icon name="minus" />}
                  onClick={() => zoomCenter(1 / 1.25)}
                />
              </TooltipV2>
              <TooltipV2 placement="top" value={labels.zoomIn}>
                <IconButtonV2
                  type="button"
                  size="normal"
                  variant="ghost-muted"
                  aria-label={labels.zoomIn}
                  icon={<Icon name="plus" />}
                  onClick={() => zoomCenter(1.25)}
                />
              </TooltipV2>
              <TooltipV2 placement="top" value={labels.resetView}>
                <IconButtonV2
                  type="button"
                  size="normal"
                  variant="ghost-muted"
                  aria-label={labels.resetView}
                  icon={<Icon name="reset" />}
                  onClick={resetView}
                />
              </TooltipV2>
            </>
          )}
          <TooltipV2 placement="top" value={sourceVisible() ? labels.preview : labels.source}>
            <IconButtonV2
              type="button"
              size="normal"
              variant="ghost-muted"
              aria-label={sourceVisible() ? labels.preview : labels.source}
              aria-pressed={sourceVisible()}
              icon={<Icon name="code" />}
              onClick={() => showSource(!sourceVisible())}
            />
          </TooltipV2>
        </>
      ),
      toggle,
    )
    const gestures = new AbortController()
    if (pannable) {
      output.dataset.pannable = ""
      // 普通滚轮保留给聊天列表滚动，仅 Ctrl + 滚轮（含触控板双指捏合）缩放，避免阅读时误触。
      output.addEventListener(
        "wheel",
        (event) => {
          if (!event.ctrlKey && !event.metaKey) return
          event.preventDefault()
          const rect = output.getBoundingClientRect()
          const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY
          zoomAt(Math.exp(-delta * 0.002), event.clientX - rect.left, event.clientY - rect.top)
        },
        { passive: false, signal: gestures.signal },
      )
      output.addEventListener(
        "pointerdown",
        (event) => {
          if (event.button !== 0) return
          const start = { x: event.clientX - view.x, y: event.clientY - view.y }
          output.setPointerCapture(event.pointerId)
          output.dataset.dragging = ""
          const move = (next: PointerEvent) => {
            view.x = next.clientX - start.x
            view.y = next.clientY - start.y
            applyView()
          }
          const end = () => {
            delete output.dataset.dragging
            output.removeEventListener("pointermove", move)
            output.removeEventListener("pointerup", end)
            output.removeEventListener("pointercancel", end)
          }
          output.addEventListener("pointermove", move)
          output.addEventListener("pointerup", end)
          output.addEventListener("pointercancel", end)
        },
        { signal: gestures.signal },
      )
      output.addEventListener("dblclick", resetView, { signal: gestures.signal })
    }
    showSource(false)
    const parent = old ?? wrapper
    parent.replaceWith(host)
    sourceView.append(wrapper)
    host.append(toggle, output, sourceView, status)
    let disposed = false
    let run = 0
    const renderDiagram = async () => {
      const current = ++run
      try {
        const { renderCanvas } = await import("./canvas-render")
        if (disposed || current !== run) return
        const result = await renderCanvas(`${fence}${language}\n${token.text}\n${fence}`)
        if (disposed || current !== run) return
        status.hidden = result.ok
        status.setAttribute("role", result.ok ? "status" : "alert")
        status.textContent = result.ok ? "" : result.error
        if (result.ok) output.innerHTML = result.html
        // 主题切换会整体重绘，新节点沿用用户当前的平移缩放状态。
        if (result.ok) applyView()
        if (!result.ok) showSource(true)
      } catch (error) {
        if (disposed || current !== run) return
        status.hidden = false
        status.setAttribute("role", "alert")
        status.textContent = error instanceof Error ? error.message : String(error)
        showSource(true)
      }
    }
    const observer = new MutationObserver(() => void renderDiagram())
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-color-scheme", "style"],
    })
    mounted.set(host, {
      source: identity,
      dispose: () => {
        disposed = true
        run++
        observer.disconnect()
        gestures.abort()
        disposeToggle()
      },
    })
    void renderDiagram()
  })
}
