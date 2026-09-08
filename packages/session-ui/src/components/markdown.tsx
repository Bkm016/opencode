import { useMarked } from "@opencode-ai/ui/context/marked"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import morphdom from "morphdom"
import { checksum } from "@opencode-ai/core/util/encode"
import {
  type Accessor,
  type ComponentProps,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  createUniqueId,
  onCleanup,
  type Setter,
  splitProps,
} from "solid-js"
import { isServer, render } from "solid-js/web"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { markdownLanguage } from "@opencode-ai/ui/context/markdown-language"
import { canReusePendingBlock, project, type Block, type Projection } from "./markdown-stream"
import {
  disposeStreamingCode,
  highlightStreamingCode,
  MarkdownWorkerDisposedError,
  MarkdownWorkerSupersededError,
  MarkdownWorkerUnavailableError,
} from "./markdown-worker"
import { markdownBlockKey, type MarkdownToken } from "./markdown-worker-protocol"
import { shouldResetCodeTokens, type RenderedCodeState } from "./markdown-code-state"
import { getCachedMarkdown, sanitizeMarkdown, touchCachedMarkdown, type MarkdownCacheEntry } from "./markdown-cache"
import { decorateMarkdownDiagrams, disposeMarkdownDiagrams } from "./markdown-diagram"

type RenderedBlock =
  | (MarkdownCacheEntry & { key: string; mode: Exclude<Block["mode"], "code"> })
  | {
      key: string
      mode: "code"
      raw: string
      hash: string
      language: string
      complete: boolean
      generation: number
      stable: MarkdownToken[]
      unstable: MarkdownToken[]
    }

type RenderResult = {
  text: string
  blocks: RenderedBlock[]
}

const renderedCodeTokens = new WeakMap<HTMLDivElement, RenderedCodeState>()

function escape(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function fallback(markdown: string) {
  return escape(markdown).replace(/\r\n?/g, "\n").replace(/\n/g, "<br>")
}

async function code(text: string, language: string | undefined, key: string, complete = false) {
  const name = markdownLanguage(language)
  try {
    const result = await highlightStreamingCode(key, text, name, complete)
    return { language: name, generation: result.generation, stable: result.stable, unstable: result.unstable }
  } catch (error) {
    if (
      !(error instanceof MarkdownWorkerDisposedError) &&
      !(error instanceof MarkdownWorkerSupersededError) &&
      !(error instanceof MarkdownWorkerUnavailableError)
    )
      console.error("Markdown highlighting worker failed", error)
    return { language: name, generation: 0, stable: [], unstable: [[text, ""] as MarkdownToken] }
  }
}

type CopyLabels = {
  copy: string
  copied: string
}

type CopyButtonState = {
  setLabels: Setter<CopyLabels>
  setCopied: Setter<boolean>
  dispose: () => void
}

const copyButtonState = new WeakMap<HTMLElement, CopyButtonState>()

function createCopyButton(labels: CopyLabels) {
  const host = document.createElement("div")
  host.setAttribute("data-slot", "markdown-copy-button")

  const state: Partial<CopyButtonState> = {}
  const dispose = render(() => {
    const [labelState, setLabels] = createSignal(labels, { equals: false })
    const [copied, setCopied] = createSignal(false)
    state.setLabels = setLabels
    state.setCopied = setCopied
    return <MarkdownCopyButton labels={labelState} copied={copied} />
  }, host)
  state.dispose = dispose
  copyButtonState.set(host, state as CopyButtonState)
  return host
}

function MarkdownCopyButton(props: { labels: Accessor<CopyLabels>; copied: Accessor<boolean> }) {
  const label = () => (props.copied() ? props.labels().copied : props.labels().copy)
  return (
    <TooltipV2 placement="top" value={label()}>
      <IconButtonV2
        type="button"
        size="normal"
        variant="ghost-muted"
        aria-label={label()}
        icon={
          <>
            <IconV2 name="outline-copy" data-copy-icon />
            <IconV2 name="check" data-check-icon />
          </>
        }
      />
    </TooltipV2>
  )
}

function setCopyState(host: HTMLElement, labels: CopyLabels, copied: boolean) {
  const state = copyButtonState.get(host)
  state?.setLabels(labels)
  state?.setCopied(copied)
  if (copied) {
    host.setAttribute("data-copied", "true")
    return
  }
  host.removeAttribute("data-copied")
}

function disposeCopyButton(host: HTMLElement) {
  copyButtonState.get(host)?.dispose()
  copyButtonState.delete(host)
}

function disposeCopyButtons(root: Element) {
  disposeMarkdownDiagrams(root)
  const hosts = [
    ...(root instanceof HTMLElement && root.getAttribute("data-slot") === "markdown-copy-button" ? [root] : []),
    ...Array.from(root.querySelectorAll('[data-slot="markdown-copy-button"]')).filter(
      (el): el is HTMLElement => el instanceof HTMLElement,
    ),
  ]
  hosts.forEach(disposeCopyButton)
}

function ensureCodeWrapper(block: HTMLPreElement, labels: CopyLabels) {
  const parent = block.parentElement
  if (!parent) return
  const wrapped = parent.getAttribute("data-component") === "markdown-code"
  if (!wrapped) {
    const wrapper = document.createElement("div")
    wrapper.setAttribute("data-component", "markdown-code")
    parent.replaceChild(wrapper, block)
    wrapper.appendChild(block)
    wrapper.appendChild(createCopyButton(labels))
    return
  }

  const buttons = Array.from(parent.querySelectorAll('[data-slot="markdown-copy-button"]')).filter(
    (el): el is HTMLButtonElement => el instanceof HTMLButtonElement,
  )

  if (buttons.length === 0) {
    parent.appendChild(createCopyButton(labels))
    return
  }

  for (const button of buttons.slice(1)) {
    disposeCopyButton(button)
    button.remove()
  }
}

function decorate(root: HTMLDivElement, labels: CopyLabels) {
  const blocks = Array.from(root.querySelectorAll("pre"))
  for (const block of blocks) {
    ensureCodeWrapper(block, labels)
  }
}

function setupCodeCopy(root: HTMLDivElement, getLabels: () => CopyLabels) {
  const timeouts = new Map<HTMLElement, ReturnType<typeof setTimeout>>()

  const updateLabel = (button: HTMLElement) => {
    const labels = getLabels()
    const copied = button.getAttribute("data-copied") === "true"
    setCopyState(button, labels, copied)
  }

  const handleClick = async (event: MouseEvent) => {
    const target = event.target
    if (!(target instanceof Element)) return

    const button = target.closest('[data-slot="markdown-copy-button"]')
    if (!(button instanceof HTMLElement)) return
    const code = button.closest('[data-component="markdown-code"]')?.querySelector("code")
    const content = code?.textContent ?? ""
    if (!content) return
    const clipboard = navigator?.clipboard
    if (!clipboard) return
    await clipboard.writeText(content)
    const labels = getLabels()
    setCopyState(button, labels, true)
    const existing = timeouts.get(button)
    if (existing) clearTimeout(existing)
    const timeout = setTimeout(() => setCopyState(button, labels, false), 2000)
    timeouts.set(button, timeout)
  }

  const buttons = Array.from(root.querySelectorAll('[data-slot="markdown-copy-button"]'))
  for (const button of buttons) {
    if (button instanceof HTMLElement) updateLabel(button)
  }

  root.addEventListener("click", handleClick)

  return () => {
    root.removeEventListener("click", handleClick)
    for (const timeout of timeouts.values()) {
      clearTimeout(timeout)
    }
    disposeCopyButtons(root)
  }
}

function initialResult(text: string, key: string | undefined, projection: Projection, owner: string): RenderResult {
  if (!text) return { text, blocks: [] }
  const base = key ?? checksum(text)
  if (base) {
    const blocks = projection.blocks.flatMap((block, index) => {
      if (block.mode === "code") return []
      const cacheKey = `${base}:${index}:${block.mode}`
      const cached = getCachedMarkdown(cacheKey)
      if (cached?.raw !== block.raw) return []
      return [{ key: `${owner}:${cacheKey}`, mode: block.mode, ...cached }]
    })
    if (blocks.length === projection.blocks.length) return { text, blocks }
  }
  return {
    text,
    blocks: [
      {
        key: "initial",
        mode: "full",
        raw: text,
        hash: checksum(text) ?? "",
        html: fallback(text),
      },
    ],
  }
}

export function Markdown(
  props: ComponentProps<"div"> & {
    text: string
    cacheKey?: string
    streaming?: boolean
    class?: string
    classList?: Record<string, boolean>
  },
) {
  const [local, others] = splitProps(props, ["text", "cacheKey", "streaming", "class", "classList"])
  const marked = useMarked()
  const i18n = useI18n()
  const [root, setRoot] = createSignal<HTMLDivElement>()
  const owner = createUniqueId()
  const activeCodeKeys = new Set<string>()
  const completedCode = new Map<string, Extract<RenderedBlock, { mode: "code" }>>()
  const projection = createMemo((previous: Projection | undefined) =>
    project(previous, local.text, local.streaming ?? false),
  )
  const [html] = createResource(
    () => {
      return {
        text: local.text,
        key: local.cacheKey,
        projection: projection(),
      }
    },
    async (src) => {
      if (isServer)
        return {
          text: src.text,
          blocks: [
            {
              key: "server",
              mode: "full" as const,
              raw: src.text,
              hash: checksum(src.text) ?? "",
              html: fallback(src.text),
            },
          ],
        } satisfies RenderResult
      if (!src.text) return { text: src.text, blocks: [] } satisfies RenderResult

      const base = src.key ?? checksum(src.text)
      return Promise.all(
        src.projection.blocks.map(async (block, index) => {
          const key = base ? `${base}:${index}:${block.mode}` : undefined
          const blockKey = markdownBlockKey(owner, src.key, index, block.mode)

          if (block.mode === "code") {
            const cached = completedCode.get(blockKey)
            if (block.complete && cached?.raw === block.raw) return cached
            const result = await code(block.src, block.language, blockKey, block.complete)
            const rendered = {
              key: blockKey,
              mode: block.mode,
              raw: block.raw,
              hash: String(block.raw.length),
              complete: !!block.complete,
              ...result,
            }
            if (block.complete) completedCode.set(blockKey, rendered)
            return rendered
          }

          if (key) {
            const cached = getCachedMarkdown(key)
            if (cached?.raw === block.raw) {
              touchCachedMarkdown(key, cached)
              return { key: blockKey, mode: block.mode, ...cached }
            }
          }

          const hash = checksum(block.raw)
          const safe = sanitizeMarkdown(await Promise.resolve(marked.parse(block.src)))
          if (key && hash) touchCachedMarkdown(key, { raw: block.raw, hash, html: safe })
          return { key: blockKey, mode: block.mode, raw: block.raw, hash: hash ?? "", html: safe }
        }),
      )
        .then((blocks) => ({ text: src.text, blocks }) satisfies RenderResult)
        .catch(
          () =>
            ({
              text: src.text,
              blocks: [
                {
                  key: base ?? "fallback",
                  mode: "full" as const,
                  raw: src.text,
                  hash: checksum(src.text) ?? "",
                  html: fallback(src.text),
                },
              ],
            }) satisfies RenderResult,
        )
    },
    {
      initialValue: initialResult(local.text, local.cacheKey, projection(), owner),
    },
  )

  let copyCleanup: (() => void) | undefined

  createEffect(() => {
    const container = root()
    const result = html.latest ?? html()
    const projected = projection()
    const content = local.text ? pendingBlocks(result, projected, local.cacheKey, owner) : []
    const streaming = !!local.streaming
    if (!container) return
    if (isServer) return
    if (content.length === 0) {
      disposeCopyButtons(container)
      container.innerHTML = ""
      return
    }

    const labels = {
      copy: i18n.t("ui.message.copy"),
      copied: i18n.t("ui.message.copied"),
      loading: i18n.t("ui.canvas.loading"),
      source: i18n.t("ui.diagram.source"),
      preview: i18n.t("ui.diagram.preview"),
    }
    const nextCodeKeys = new Set(content.filter((block) => block.mode === "code").map((block) => block.key))
    activeCodeKeys.forEach((key) => {
      if (!nextCodeKeys.has(key)) disposeCode(key)
    })
    activeCodeKeys.clear()
    nextCodeKeys.forEach((key) => activeCodeKeys.add(key))
    // Content updates stay instant — stream motion is the caret only (CSS pulse).
    const blocks = () =>
      [...container.children].filter(
        (node): node is HTMLElement => node instanceof HTMLElement && node.dataset.markdownBlock !== undefined,
      )
    content.forEach((block, index) => {
      const current = blocks()[index]
      // 已完成的图表 DOM 自主管理异步结果；正文继续流式增长时不反复重建图表。
      const unchanged =
        current?.dataset.diagramSource === block.raw && current.querySelector('[data-component="markdown-diagram"]')
      if (unchanged) {
        // 图表可能先于 Worker 高亮完成挂载；复用预览时仍须补入源码颜色。
        if (block.mode === "code") updateCodeBlock(container, current, block, labels)
        return
      }
      // 源码被编辑或重新进入流式状态时撤销旧图，不让旧成功图冒充当前未完成内容。
      if (current?.dataset.diagramSource !== undefined) {
        disposeCopyButtons(current)
        current.replaceChildren()
        delete current.dataset.diagramSource
        delete current.dataset.markdownHash
        renderedCodeTokens.delete(current)
      }
      updateBlock(container, current, block, labels)
      const updated = blocks()[index]
      if (!updated || (block.mode === "code" && !block.complete)) return
      decorateMarkdownDiagrams(updated, block.raw, {
        loading: labels.loading,
        source: labels.source,
        preview: labels.preview,
      })
      if (updated.querySelector('[data-component="markdown-diagram"]')) updated.dataset.diagramSource = block.raw
    })
    blocks()
      .slice(content.length)
      .forEach((node) => {
        disposeCopyButtons(node)
        node.remove()
      })
    container
      .querySelectorAll<HTMLElement>('[data-slot="markdown-copy-button"]')
      .forEach((button) => setCopyState(button, labels, button.dataset.copied === "true"))
    if (!copyCleanup)
      copyCleanup = setupCodeCopy(container, () => ({
        copy: i18n.t("ui.message.copy"),
        copied: i18n.t("ui.message.copied"),
      }))
    syncStreamCaret(container, streaming)
  })

  onCleanup(() => {
    if (copyCleanup) copyCleanup()
    activeCodeKeys.forEach(disposeCode)
    completedCode.clear()
  })

  return (
    <div
      data-component="markdown"
      data-streaming={local.streaming ? "true" : undefined}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
      ref={setRoot}
      {...others}
    />
  )
}

function streamCaretHost(container: HTMLElement) {
  const blocks = [...container.children].filter(
    (node): node is HTMLElement => node instanceof HTMLElement && node.dataset.markdownBlock !== undefined,
  )
  const last = blocks.at(-1)
  if (!last) return container

  // Prefer the deepest last text-bearing element so the caret sits inline
  // after the current stream end, not on the next layout line.
  const skip = "script, style, [data-slot='markdown-copy-button'], [data-slot='markdown-stream-caret']"
  const candidates = last.querySelectorAll<HTMLElement>(
    "p, li, td, th, h1, h2, h3, h4, h5, h6, pre code, code, span, a, em, strong, blockquote",
  )
  for (let i = candidates.length - 1; i >= 0; i--) {
    const el = candidates[i]
    if (!el || el.matches(skip) || el.closest(skip)) continue
    if (el.closest("[data-component='markdown-code']") && el.tagName !== "CODE") continue
    if ((el.textContent?.length ?? 0) === 0 && el.children.length === 0) continue
    return el
  }

  // display:contents block wrappers — walk their element children.
  const kids = [...last.children].filter(
    (node): node is HTMLElement => node instanceof HTMLElement && !node.matches(skip) && !node.closest(skip),
  )
  return kids.at(-1) ?? last
}

function syncStreamCaret(container: HTMLElement, streaming: boolean) {
  const existing = container.querySelector<HTMLElement>('[data-slot="markdown-stream-caret"]')
  if (!streaming) {
    existing?.remove()
    return
  }
  // Reuse the same node so CSS pulse never restarts mid-stream.
  const caret =
    existing ??
    (() => {
      const el = document.createElement("span")
      el.dataset.slot = "markdown-stream-caret"
      el.setAttribute("aria-hidden", "true")
      return el
    })()
  const host = streamCaretHost(container)
  if (caret.parentElement !== host || host.lastChild !== caret) host.appendChild(caret)
}

function pendingBlocks(
  result: RenderResult | undefined,
  projection: Projection | undefined,
  cacheKey: string | undefined,
  owner: string,
) {
  if (!result) return []
  if (!projection || result.text === projection.text) return result.blocks
  const initial = result.blocks.length === 1 && result.blocks[0]?.key === "initial"
  return projection.blocks.map((block, index) => {
    const current = initial ? undefined : result.blocks[index]
    if (current && canReusePendingBlock(current, block)) return current
    const key = markdownBlockKey(owner, cacheKey, index, block.mode)
    if (block.mode !== "code")
      return { key, mode: block.mode, raw: block.raw, hash: String(block.raw.length), html: fallback(block.src) }
    return {
      key,
      mode: block.mode,
      raw: block.raw,
      hash: String(block.raw.length),
      language: block.language ?? "text",
      complete: !!block.complete,
      stable: [],
      generation: 0,
      unstable: [[block.src, ""] as MarkdownToken],
    }
  })
}

function disposeCode(key: string) {
  disposeStreamingCode(key)
}

function updateBlock(
  container: HTMLDivElement,
  current: Element | undefined,
  block: RenderedBlock,
  labels: CopyLabels,
) {
  if (block.mode === "code") {
    updateCodeBlock(container, current, block, labels)
    return
  }
  if (
    current instanceof HTMLDivElement &&
    current.dataset.markdownKey === block.key &&
    current.dataset.markdownHash === block.hash
  )
    return

  const next = document.createElement("div")
  next.dataset.markdownBlock = ""
  next.dataset.markdownKey = block.key
  next.dataset.markdownHash = block.hash
  next.style.display = "contents"
  next.innerHTML = block.html
  decorate(next, labels)

  if (!(current instanceof HTMLDivElement)) {
    container.appendChild(next)
    return
  }

  morphdom(current, next, {
    onBeforeElUpdated: (fromEl, toEl) => {
      if (
        fromEl instanceof HTMLElement &&
        toEl instanceof HTMLElement &&
        fromEl.getAttribute("data-slot") === "markdown-copy-button" &&
        toEl.getAttribute("data-slot") === "markdown-copy-button"
      ) {
        return false
      }
      if (fromEl.isEqualNode(toEl)) return false
      return true
    },
    onBeforeNodeDiscarded: (node) => {
      if (node instanceof HTMLElement && node.dataset.slot === "markdown-stream-caret") return false
      if (node instanceof Element) disposeCopyButtons(node)
      return true
    },
  })
}

function updateCodeBlock(
  container: HTMLDivElement,
  current: Element | undefined,
  block: Extract<RenderedBlock, { mode: "code" }>,
  labels: CopyLabels,
) {
  const existing = current instanceof HTMLDivElement && current.dataset.markdownKey === block.key ? current : undefined
  const next = existing ?? document.createElement("div")
  next.dataset.markdownBlock = ""
  next.dataset.markdownKey = block.key
  next.dataset.markdownHash = block.hash
  next.dataset.markdownComplete = block.complete ? "true" : "false"
  next.style.display = "contents"

  const code = existing?.querySelector("code")
  if (code instanceof HTMLElement) {
    code.className = `language-${block.language}`
    const previous = renderedCodeTokens.get(next)
    const reset = shouldResetCodeTokens(previous, {
      language: block.language,
      generation: block.generation,
      stableCount: block.stable.length,
      raw: block.raw,
    })
    const stableCount = reset ? 0 : previous!.stableCount
    const tail = [...block.stable.slice(stableCount), ...block.unstable]
    const prior = reset ? [] : previous!.unstable
    const prefix = prior.findIndex((token, index) => !sameToken(token, tail[index]))
    const keep = stableCount + (prefix < 0 ? Math.min(prior.length, tail.length) : prefix)
    while (code.children.length > keep) code.lastElementChild?.remove()
    const incoming = tail.slice(keep - stableCount).map(createTokenSpan)
    incoming.forEach((span) => code.appendChild(span))
    renderedCodeTokens.set(next, {
      language: block.language,
      generation: block.generation,
      stableCount: block.stable.length,
      unstable: block.unstable,
      raw: block.raw,
    })
    return
  }

  const wrapper = document.createElement("div")
  wrapper.setAttribute("data-component", "markdown-code")
  const pre = document.createElement("pre")
  pre.className = "shiki OpenCode"
  const codeElement = document.createElement("code")
  codeElement.className = `language-${block.language}`
  ;[...block.stable, ...block.unstable].map(createTokenSpan).forEach((span) => codeElement.appendChild(span))
  pre.appendChild(codeElement)
  wrapper.appendChild(pre)
  wrapper.appendChild(createCopyButton(labels))
  next.appendChild(wrapper)
  renderedCodeTokens.set(next, {
    language: block.language,
    generation: block.generation,
    stableCount: block.stable.length,
    unstable: block.unstable,
    raw: block.raw,
  })
  if (current) {
    disposeCopyButtons(current)
    current.replaceWith(next)
    return
  }
  container.appendChild(next)
}

function sameToken(left: MarkdownToken, right: MarkdownToken | undefined) {
  return !!right && left[0] === right[0] && left[1] === right[1]
}

function createTokenSpan(token: MarkdownToken) {
  const span = document.createElement("span")
  span.setAttribute("style", token[1])
  span.textContent = token[0]
  return span
}
