import type { SessionFindMatch } from "./session-find"

const LAYER_ATTR = "data-session-find-highlight-layer"

type Layer = {
  root: HTMLDivElement
  host: HTMLElement
  cleanup: Array<() => void>
  // 聊天区 DOM 每变一次加一；没变时复用文字索引，滚动重绘和重试不再重扫整个会话。
  version: number
  observer: MutationObserver
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
  const next: Layer = {
    root,
    host,
    cleanup: [],
    version: 0,
    observer: new MutationObserver(() => {
      next.version++
    }),
  }
  next.observer.observe(host, { subtree: true, childList: true, characterData: true })
  layer = next
  return next
}

function domVersion(current: Layer) {
  // 回调是异步的，同一任务里刚发生的变动要先取出来，避免用到过期索引。
  if (current.observer.takeRecords().length > 0) current.version++
  return current.version
}

export function clearSessionFindHighlights() {
  if (!layer) {
    document.querySelectorAll(`[${LAYER_ATTR}]`).forEach((node) => node.remove())
    return
  }
  for (const stop of layer.cleanup) stop()
  layer.cleanup = []
  layer.observer.disconnect()
  layer.root.remove()
  layer = undefined
}

const SKIP_SELECTOR = "script, style, [data-slot='markdown-copy-button']"

function collectTextNodes(root: Node) {
  const nodes: Text[] = []
  if (root instanceof Element && root.closest(SKIP_SELECTOR)) return nodes
  // 遇到要排除的元素直接跳过整棵子树，而不是对每个文字节点都向上 closest()：
  // 长会话里代码着色产生上万个文字节点，逐个 closest() 要数秒。
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node instanceof Element && node.matches(SKIP_SELECTOR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  })
  let node = walker.nextNode()
  while (node) {
    if (node instanceof Text && node.data.length > 0) nodes.push(node)
    node = walker.nextNode()
  }
  return nodes
}

// map 按 start 递增，二分找到包含 offset 的文字节点。
function findIndexItem(map: TextIndex["map"], offset: number) {
  let lo = 0
  let hi = map.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (map[mid]!.end <= offset) lo = mid + 1
    else hi = mid
  }
  return lo
}

type TextIndex = { text: string; lower: string; map: Array<{ node: Text; start: number; end: number }> }

const indexCache = new WeakMap<Element, { layer: Layer; version: number; index: TextIndex }>()

function buildTextIndex(root: Element, current?: Layer): TextIndex {
  const version = current ? domVersion(current) : -1
  const cached = indexCache.get(root)
  if (current && cached && cached.layer === current && cached.version === version) return cached.index
  const nodes = collectTextNodes(root)
  const parts: string[] = []
  let length = 0
  const map: TextIndex["map"] = []
  for (const node of nodes) {
    const start = length
    parts.push(node.data)
    length += node.data.length
    map.push({ node, start, end: length })
  }
  const text = parts.join("")
  const index = { text, lower: text.toLowerCase(), map }
  if (current) indexCache.set(root, { layer: current, version, index })
  return index
}

// 匹配位置只存纯数据，不持有 Range：存活的 Range 会让浏览器在每次 DOM 变动时逐个更新，
// 长会话里上千个匹配会让查找期间的任何渲染慢几十倍。需要测量时借用同一个 Range。
type Hit = { startNode: Text; startOffset: number; endNode: Text; endOffset: number }

const scratch = typeof document === "undefined" ? undefined : new Range()

function withRange<T>(hit: Hit, fn: (range: Range) => T) {
  const range = scratch ?? new Range()
  range.setStart(hit.startNode, Math.min(hit.startOffset, hit.startNode.data.length))
  range.setEnd(hit.endNode, Math.min(hit.endOffset, hit.endNode.data.length))
  try {
    return fn(range)
  } finally {
    range.setStart(document, 0)
    range.collapse(true)
  }
}

function rangeFromIndex(index: TextIndex, start: number, end: number): Hit | undefined {
  if (start >= end || start < 0 || end > index.text.length) return
  if (index.map.length === 0) return
  const first = index.map[findIndexItem(index.map, start)]
  const last = index.map[findIndexItem(index.map, end - 1)]
  if (!first || !last) return
  const startNode = first.node
  const startOffset = start - first.start
  const endNode = last.node
  const endOffset = end - last.start
  return {
    startNode,
    startOffset: Math.max(0, Math.min(startOffset, startNode.data.length)),
    endNode,
    endOffset: Math.max(0, Math.min(endOffset, endNode.data.length)),
  }
}

function rangesForQuery(root: Element, query: string, caseSensitive: boolean, current?: Layer) {
  const needle = caseSensitive ? query : query.toLowerCase()
  if (!needle) return [] as Hit[]
  const index = buildTextIndex(root, current)
  const haystack = caseSensitive ? index.text : index.lower
  const ranges: Hit[] = []
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

function paintRanges(host: HTMLElement, ranges: Hit[], active: Hit | undefined) {
  const current = ensureLayer(host)
  const viewport = host.getBoundingClientRect()
  const origin = current.root.getBoundingClientRect()
  const clipCache = new Map<Element, { left: number; top: number; right: number; bottom: number }>()

  const clipsFor = (hit: Hit) => {
    const owner = hit.startNode.parentElement
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

  const boxes = document.createDocumentFragment()
  // 先用所在代码块/段落的外框粗筛：屏幕外代码块开了 content-visibility，
  // 直接量匹配文字会强制渲染整个代码块。
  const blockCache = new Map<Element, boolean>()
  const nearViewport = (hit: Hit) => {
    const owner = hit.startNode.parentElement
    const block = owner?.closest("pre") ?? owner
    if (!block) return true
    const cached = blockCache.get(block)
    if (cached !== undefined) return cached
    const rect = block.getBoundingClientRect()
    const near = rect.bottom >= viewport.top && rect.top <= viewport.bottom
    blockCache.set(block, near)
    return near
  }
  const add = (hit: Hit, kind: "all" | "active") => {
    if (!nearViewport(hit)) return
    const rects = withRange(hit, (range) => Array.from(range.getClientRects()))
    for (const rect of rects) {
      if (rect.width < 1 || rect.height < 1) continue
      // 不在可视区内的匹配不画，长会话里大部分匹配都在屏幕外。
      if (rect.bottom < viewport.top || rect.top > viewport.bottom) continue
      // Clip to host viewport so highlights never spill outside the chat pane.
      const clip = clipsFor(hit)
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
      boxes.appendChild(box)
    }
  }

  for (const range of ranges) add(range, "all")
  if (active) add(active, "active")
  current.root.replaceChildren(boxes)
}

function scrollRangeIntoView(hit: Hit, host: HTMLElement) {
  const scrollables: HTMLElement[] = []
  let parent = hit.startNode.parentElement
  while (parent) {
    const style = getComputedStyle(parent)
    if (/^(auto|clip|hidden|scroll)$/.test(style.overflowY)) scrollables.push(parent)
    if (parent === host) break
    parent = parent.parentElement
  }

  for (const scrollable of scrollables) {
    const rect = withRange(hit, (range) => range.getBoundingClientRect())
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

  // 滚动事件一帧内可能触发多次，合并到下一帧只重绘一次。
  let frame: number | undefined
  const schedule = () => {
    if (frame !== undefined) return
    frame = requestAnimationFrame(() => {
      frame = undefined
      repaint()
    })
  }
  host.addEventListener("scroll", schedule, { passive: true })
  window.addEventListener("resize", schedule)
  current.cleanup.push(() => host.removeEventListener("scroll", schedule))
  current.cleanup.push(() => window.removeEventListener("resize", schedule))
  current.cleanup.push(() => {
    if (frame !== undefined) cancelAnimationFrame(frame)
  })
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
    const current = ensureLayer(host)
    const roots = indexPartRoots(host)
    const nextAll: Hit[] = []
    const byRoot = new Map<Element, Hit[]>()
    for (const match of input.matches) {
      const root = roots.get(match.partID)
      if (!root) continue
      if (byRoot.has(root)) continue
      const hits = rangesForQuery(root, query, caseSensitive, current)
      byRoot.set(root, hits)
      nextAll.push(...hits)
    }
    let nextActive: Hit | undefined
    if (active) {
      const root = roots.get(active.partID)
      if (root) {
        const local = byRoot.get(root) ?? rangesForQuery(root, query, caseSensitive, current)
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
