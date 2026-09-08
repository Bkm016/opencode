import { useI18n } from "@opencode-ai/ui/context/i18n"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { createEffect, on, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { describeError, renderCanvas } from "./canvas-render"
import { writeClipboardImage } from "./clipboard-image"
import "./canvas-document.css"

export interface CanvasDocumentProps {
  /** 画布文档内容：markdown 正文 + 可选 ```mermaid 围栏 */
  // 同时支持 ```vega-lite 数据图表围栏，共用主题与图片复制链路。
  content: string
  /** 文档标题，仅作为可读说明展示，工具栏由主面板提供 */
  title?: string
  /** 渲染状态回报：成功为 undefined，失败为可读错误（主面板可回喂模型） */
  onError?: (error: string | undefined) => void
  /** 将当前错误交给宿主准备修复草稿，操作紧随错误提示展示。 */
  onFix?: (error: string) => void
  fixDisabled?: boolean
  /** 只在完整内容渲染成功后向宿主提供复制能力，卸载或更新时撤销。 */
  onCopyReady?: (copy: (() => Promise<void>) | undefined) => void
}

/**
 * 原生讲解画布
 * 渲染 markdown + 白名单 mermaid 图，主题与排版完全由宿主接管；
 * 内容整体渲染成功才替换当前画面，失败保留上一份成功结果并回报错误。
 */
export function CanvasDocument(props: CanvasDocumentProps) {
  const i18n = useI18n()
  const [state, setState] = createStore({ loading: false, hasHeading: false })
  let scrollEl: HTMLDivElement | undefined
  let paperEl: HTMLDivElement | undefined
  let bodyEl: HTMLDivElement | undefined
  let errorEl: HTMLDivElement | undefined
  let errorTextEl: HTMLSpanElement | undefined
  let shownError: string | undefined
  let ready = false
  let disposed = false
  let run = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const copyImage = async () => {
    if (!paperEl || disposed || state.loading || shownError) throw new Error(i18n.t("ui.canvas.copyNotReady"))
    // 克隆成功画面的完整正文，独立排版以去除视口滚动、缩放和工具栏的影响。
    const holder = document.createElement("div")
    holder.style.cssText = "position:fixed;left:-100000px;top:0;pointer-events:none;"
    holder.setAttribute("aria-hidden", "true")
    const frame = document.createElement("div")
    frame.dataset.component = "canvas-document"
    frame.style.cssText =
      "width:960px;height:auto;min-height:0;display:block;padding:24px;box-sizing:border-box;zoom:1;"
    const paper = paperEl.cloneNode(true) as HTMLDivElement
    paper.style.maxWidth = "none"
    paper.style.width = "100%"
    paper.style.padding = "32px 36px"
    for (const element of paper.querySelectorAll<HTMLElement>("pre, table, .canvas-diagram, .katex-display")) {
      element.style.overflow = "visible"
    }
    for (const pre of paper.querySelectorAll<HTMLElement>("pre")) {
      pre.style.whiteSpace = "pre-wrap"
      pre.style.overflowWrap = "anywhere"
    }
    frame.append(paper)
    holder.append(frame)
    document.body.append(holder)
    try {
      await document.fonts.ready
      await Promise.all(Array.from(paper.querySelectorAll("img"), (image) => image.decode()))
      frame.style.width = `${Math.max(960, frame.scrollWidth)}px`
      const width = Math.ceil(frame.scrollWidth)
      const height = Math.ceil(frame.scrollHeight)
      // 限制像素分配而不是静默裁切；过长文档明确提示拆分。
      const pixelRatio = Math.min(2, 16384 / width, 16384 / height, Math.sqrt(32_000_000 / (width * height)))
      if (!width || !height || pixelRatio < 0.75) throw new Error(i18n.t("ui.canvas.copyTooLarge"))
      const { toBlob } = await import("html-to-image")
      const blob = await toBlob(frame, {
        width,
        height,
        pixelRatio,
        skipAutoScale: true,
        backgroundColor: getComputedStyle(frame).backgroundColor,
      })
      if (!blob) throw new Error(i18n.t("ui.canvas.copyFailed"))
      if (!(await writeClipboardImage(blob))) throw new Error(i18n.t("ui.canvas.clipboardDenied"))
    } finally {
      holder.remove()
    }
  }

  const publish = (error: string | undefined) => {
    if (error === shownError) return
    shownError = error
    if (errorEl) {
      if (errorTextEl) errorTextEl.textContent = error ?? ""
      errorEl.toggleAttribute("data-hidden", !error)
    }
    props.onError?.(error)
  }

  const apply = async (content: string, current: number) => {
    const previous = scrollEl?.scrollTop ?? 0
    try {
      const result = await renderCanvas(content)
      if (disposed || current !== run) return
      if (!result.ok) {
        publish(result.error)
        return
      }
      // 全部成功才一次性替换，避免半份内容闪烁
      if (bodyEl) bodyEl.innerHTML = result.html
      setState("hasHeading", !!bodyEl?.querySelector("h1"))
      publish(undefined)
      props.onCopyReady?.(copyImage)
      requestAnimationFrame(() => {
        if (disposed || current !== run || !scrollEl) return
        scrollEl.scrollTop = previous
      })
    } catch (cause) {
      if (disposed || current !== run) return
      publish(describeError(cause))
    } finally {
      // 队列在模块层串行，本组件仍按 run 序号丢弃过期结果；仅在最后一次 settle 时更新加载状态。
      if (!disposed && current === run) setState("loading", false)
    }
  }

  const schedule = (content: string) => {
    // 内容变化立即作废旧结果，并合并短时间内连续编辑，避免先展示已经过期的图。
    const current = ++run
    clearTimeout(timer)
    setState("loading", true)
    props.onCopyReady?.(undefined)
    timer = setTimeout(() => void apply(content, current), 100)
  }

  onMount(() => {
    ready = true
    schedule(props.content)
    const observer = new MutationObserver(() => schedule(props.content))
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-color-scheme", "style"],
    })
    onCleanup(() => observer.disconnect())
  })

  onCleanup(() => {
    disposed = true
    run++
    clearTimeout(timer)
    props.onCopyReady?.(undefined)
  })

  createEffect(
    on(
      () => props.content,
      (content) => {
        if (!ready) return
        schedule(content)
      },
    ),
  )

  return (
    <div class="canvas-document" data-component="canvas-document" aria-busy={state.loading}>
      <div data-slot="canvas-document-error" data-hidden ref={errorEl} role="alert" aria-live="polite">
        <span data-slot="canvas-document-error-text" ref={errorTextEl} />
        <Show when={props.onFix}>
          <button
            type="button"
            data-slot="canvas-document-fix"
            disabled={props.fixDisabled}
            onClick={() => {
              if (shownError) props.onFix?.(shownError)
            }}
          >
            {i18n.t("ui.canvas.fix")}
          </button>
        </Show>
      </div>
      <ScrollView
        data-slot="canvas-document-scroll"
        viewportRef={(el) => {
          scrollEl = el
        }}
      >
        <div data-slot="canvas-document-body" class="canvas-markdown" ref={paperEl}>
          <Show when={props.title && !state.hasHeading}>
            <h1 data-slot="canvas-document-title">{props.title}</h1>
          </Show>
          <div data-slot="canvas-document-content" ref={bodyEl} />
        </div>
      </ScrollView>
      <div data-slot="canvas-document-sr" class="sr-only" aria-live="polite">
        {state.loading ? i18n.t("ui.canvas.loading") : ""}
      </div>
    </div>
  )
}
