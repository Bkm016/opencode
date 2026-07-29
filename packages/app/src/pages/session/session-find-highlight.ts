import type { SessionFindMatch } from "./session-find"

const LAYER_ATTR = "data-session-find-highlight-layer"

type Layer = {
  root: HTMLDivElement
  host: HTMLElement
  cleanup: Array<() => void>
}

let layer: Layer | undefined

function ensureLayer(host: HTMLElement) {
  if (layer && layer.host === host && layer.root.isConnected) return layer

  clearSessionFindHighlights()

  // 高亮层不能挂在滚动内容上，否则滚动时内容坐标和视口坐标会被重复换算。
  const container = host.parentElement ?? host
  const style = getComputedStyle(container)
  if (style.position === "static") container.style.position = "relative"

  const root = document.createElement("div")
  root.setAttribute(LAYER_ATTR, "")
  root.setAttribute("data-component", "session-find-highlight-layer")
  root.style.cssText =
    "position:absolute;inset:0;pointer-events:none;z-index:1;overflow:hidden;"
  container.appendChild(root)
  layer = { root, host, cleanup: [] }
  return layer
}

export function clearSessionFindHighlights() {
  if (!layer) {
    document.querySelectorAll(`[${LAYER_ATTR}]`).forEach((node) => node.remove())
    return
  }
  for (const stop of layer.cleanup) stop()
  layer.cleanup = []
  layer.root.remove()
  layer = undefined
}

function collectTextNodes(root: Node) {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    if (node instanceof Text && node.data.length > 0) {
      const parent = node.parentElement
      if (parent && !parent.closest("script, style, [data-slot='markdown-copy-button']")) {
        nodes.push(node)
      }
    }
    node = walker.nextNode()
  }
  return nodes
}

function buildTextIndex(root: Element) {
  const nodes = collectTextNodes(root)
  let text = ""
  const map: Array<{ node: Text; start: number; end: number }> = []
  for (const node of nodes) {
    const start = text.length
    text += node.data
    map.push({ node, start, end: text.length })
  }
  return { text, map }
}

function rangeFromIndex(index: ReturnType<typeof buildTextIndex>, start: number, end: number) {
  if (start >= end || start < 0 || end > index.text.length) return
  let startNode: Text | undefined
  let startOffset = 0
  let endNode: Text | undefined
  let endOffset = 0
  for (const item of index.map) {
    if (!startNode && start < item.end) {
      startNode = item.node
      startOffset = start - item.start
    }
    if (end <= item.end) {
      endNode = item.node
      endOffset = end - item.start
      break
    }
  }
  if (!startNode || !endNode) return
  const range = new Range()
  range.setStart(startNode, Math.max(0, Math.min(startOffset, startNode.data.length)))
  range.setEnd(endNode, Math.max(0, Math.min(endOffset, endNode.data.length)))
  return range
}

function rangesForQuery(root: Element, query: string, caseSensitive: boolean) {
  const needle = caseSensitive ? query : query.toLowerCase()
  if (!needle) return [] as Range[]
  const index = buildTextIndex(root)
  const haystack = caseSensitive ? index.text : index.text.toLowerCase()
  const ranges: Range[] = []
  let from = 0
  while (from < haystack.length) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) break
    const range = rangeFromIndex(index, at, at + needle.length)
    if (range) ranges.push(range)
    from = at + Math.max(needle.length, 1)
  }
  return ranges
}

function indexPartRoots(scope: ParentNode) {
  const roots = new Map<string, Element>()
  for (const element of scope.querySelectorAll<HTMLElement>("[data-timeline-part-id]")) {
    const partID = element.dataset.timelinePartId
    if (partID) roots.set(partID, element)
  }
  for (const element of scope.querySelectorAll<HTMLElement>("[data-timeline-part-ids]")) {
    for (const partID of element.dataset.timelinePartIds?.split(",") ?? []) {
      if (partID && !roots.has(partID)) roots.set(partID, element)
    }
  }
  return roots
}

function paintRanges(host: HTMLElement, ranges: Range[], active: Range | undefined) {
  const current = ensureLayer(host)
  current.root.replaceChildren()
  const viewport = host.getBoundingClientRect()
  const origin = current.root.getBoundingClientRect()
  const clipCache = new Map<Element, { left: number; top: number; right: number; bottom: number }>()

  const clipsFor = (range: Range) => {
    const owner = range.startContainer.parentElement
    if (!owner) return viewport
    const cached = clipCache.get(owner)
    if (cached) return cached

    const clip = {
      left: viewport.left,
      top: viewport.top,
      right: viewport.right,
      bottom: viewport.bottom,
    }
    let parent: HTMLElement | null = owner
    while (parent && parent !== host) {
      const style = getComputedStyle(parent)
      const clipsX = /^(auto|clip|hidden|scroll)$/.test(style.overflowX)
      const clipsY = /^(auto|clip|hidden|scroll)$/.test(style.overflowY)
      if (clipsX || clipsY) {
        const bounds = parent.getBoundingClientRect()
        if (clipsX) {
          clip.left = Math.max(clip.left, bounds.left)
          clip.right = Math.min(clip.right, bounds.right)
        }
        if (clipsY) {
          clip.top = Math.max(clip.top, bounds.top)
          clip.bottom = Math.min(clip.bottom, bounds.bottom)
        }
      }
      parent = parent.parentElement
    }
    clipCache.set(owner, clip)
    return clip
  }

  const add = (range: Range, kind: "all" | "active") => {
    const rects = range.getClientRects()
    for (const rect of rects) {
      if (rect.width < 1 || rect.height < 1) continue
      // Clip to host viewport so highlights never spill outside the chat pane.
      const clip = clipsFor(range)
      const left = Math.max(clip.left, rect.left) - origin.left
      const top = Math.max(clip.top, rect.top) - origin.top
      const right = Math.min(clip.right, rect.right) - origin.left
      const bottom = Math.min(clip.bottom, rect.bottom) - origin.top
      const width = right - left
      const height = bottom - top
      if (width < 1 || height < 1) continue

      const box = document.createElement("div")
      box.setAttribute("data-slot", kind === "active" ? "session-find-active" : "session-find-hit")
      box.style.cssText = [
        "position:absolute",
        `left:${left}px`,
        `top:${top}px`,
        `width:${width}px`,
        `height:${height}px`,
        "border-radius:2px",
        kind === "active" ? "background:rgba(250,204,21,0.72)" : "background:rgba(250,204,21,0.4)",
      ].join(";")
      current.root.appendChild(box)
    }
  }

  for (const range of ranges) add(range, "all")
  if (active) add(active, "active")
}

function scrollRangeIntoView(range: Range, host: HTMLElement) {
  const scrollables: HTMLElement[] = []
  let parent = range.startContainer.parentElement
  while (parent) {
    const style = getComputedStyle(parent)
    if (/^(auto|clip|hidden|scroll)$/.test(style.overflowY)) scrollables.push(parent)
    if (parent === host) break
    parent = parent.parentElement
  }

  for (const scrollable of scrollables) {
    const rect = range.getBoundingClientRect()
    const viewport = scrollable.getBoundingClientRect()
    if (rect.top < viewport.top) {
      scrollable.scrollTop += rect.top - viewport.top - (viewport.height - rect.height) / 2
      continue
    }
    if (rect.bottom > viewport.bottom) {
      scrollable.scrollTop += rect.bottom - viewport.bottom + (viewport.height - rect.height) / 2
    }
  }
}

function bindRepaint(host: HTMLElement, repaint: () => void) {
  const current = ensureLayer(host)
  for (const stop of current.cleanup) stop()
  current.cleanup = []

  const onScroll = () => repaint()
  const onResize = () => repaint()
  host.addEventListener("scroll", onScroll, { passive: true })
  window.addEventListener("resize", onResize)
  current.cleanup.push(() => host.removeEventListener("scroll", onScroll))
  current.cleanup.push(() => window.removeEventListener("resize", onResize))
}

export function applySessionFindHighlights(input: {
  host: HTMLElement | null | undefined
  query: string
  matches: readonly SessionFindMatch[]
  activeIndex: number
  caseSensitive?: boolean
}) {
  const host = input.host
  if (!host) {
    clearSessionFindHighlights()
    return false
  }

  const query = input.query.trim()
  if (!query || input.matches.length === 0) {
    clearSessionFindHighlights()
    return true
  }

  const caseSensitive = input.caseSensitive === true
  const active = input.matches[input.activeIndex]

  const collect = () => {
    const roots = indexPartRoots(host)
    const nextAll: Range[] = []
    const nextSeen = new Set<Element>()
    for (const match of input.matches) {
      const root = roots.get(match.partID)
      if (!root) continue
      if (nextSeen.has(root)) continue
      nextSeen.add(root)
      nextAll.push(...rangesForQuery(root, query, caseSensitive))
    }
    let nextActive: Range | undefined
    if (active) {
      const root = roots.get(active.partID)
      if (root) {
        const local = rangesForQuery(root, query, caseSensitive)
        const localIndex = input.matches
          .slice(0, input.activeIndex)
          .filter((item) => roots.get(item.partID) === root).length
        nextActive = local[localIndex] ?? local[0]
      }
    }
    return { nextAll, nextActive }
  }

  const paint = () => {
    const next = collect()
    paintRanges(host, next.nextAll, next.nextActive)
    return next
  }
  const first = paint()
  bindRepaint(host, paint)

  if (!active) return first.nextAll.length > 0
  if (!first.nextActive) return false
  scrollRangeIntoView(first.nextActive, host)
  return true
}

export function scheduleSessionFindHighlights(
  input: {
    host: HTMLElement | null | undefined
    query: string
    matches: readonly SessionFindMatch[]
    activeIndex: number
    caseSensitive?: boolean
  },
  attempts = 24,
) {
  let cancelled = false
  let frame = 0
  let left = attempts
  let timer: ReturnType<typeof setTimeout> | undefined

  const run = () => {
    if (cancelled) return
    const ok = applySessionFindHighlights(input)
    left -= 1
    if (ok || left <= 0) return
    frame = requestAnimationFrame(() => {
      timer = setTimeout(run, 32)
    })
  }

  frame = requestAnimationFrame(run)
  return () => {
    cancelled = true
    cancelAnimationFrame(frame)
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function supportsSessionFindHighlight() {
  return typeof document !== "undefined"
}
