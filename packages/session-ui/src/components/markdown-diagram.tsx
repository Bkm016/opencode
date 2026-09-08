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
  labels: { loading: string; source: string; preview: string },
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
    const disposeToggle = render(
      () => (
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
      ),
      toggle,
    )
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
        disposeToggle()
      },
    })
    void renderDiagram()
  })
}
