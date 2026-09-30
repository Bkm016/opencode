import { checksum } from "@opencode-ai/core/util/encode"
import DOMPurify from "dompurify"
import { project } from "./markdown-stream"

export type MarkdownCacheEntry = {
  raw: string
  hash: string
  html: string
}

const max = 200
const cache = new Map<string, MarkdownCacheEntry>()
const config = {
  USE_PROFILES: { html: true, mathMl: true },
  SANITIZE_NAMED_PROPS: true,
  FORBID_TAGS: ["style"],
  FORBID_CONTENTS: ["style", "script"],
  ADD_TAGS: ["svg", "path"],
  ADD_ATTR: ["d", "viewBox", "preserveAspectRatio", "xmlns", "target"],
}

if (typeof window !== "undefined" && DOMPurify.isSupported) {
  // 默认 URI 白名单会删掉 file: 链接；它不会执行脚本，保留下来交给宿主按本地文件处理
  DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
    if (data.attrName !== "href" && data.attrName !== "src") return
    if (!/^file:\/\//i.test(data.attrValue.trim())) return
    if (node.nodeName !== "A" && node.nodeName !== "IMG") return
    data.forceKeepAttr = true
  })
  DOMPurify.addHook("afterSanitizeAttributes", (node: Element) => {
    // 本地路径的图片交给宿主按工作区取回；保留 src 会让浏览器按页面 base（oc://renderer/）去请求
    if (node instanceof HTMLImageElement) {
      const src = node.getAttribute("src")?.trim()
      if (!src || /^(?:https?:|data:|blob:)/i.test(src)) return
      node.setAttribute("data-local-src", src)
      node.removeAttribute("src")
      return
    }
    if (!(node instanceof HTMLAnchorElement)) return
    if (node.target !== "_blank") return

    const rel = node.getAttribute("rel") ?? ""
    const set = new Set(rel.split(/\s+/).filter(Boolean))
    set.add("noopener")
    set.add("noreferrer")
    node.setAttribute("rel", Array.from(set).join(" "))
  })
}

export function sanitizeMarkdown(html: string) {
  if (!DOMPurify.isSupported) return ""
  return DOMPurify.sanitize(html, config)
}

export function getCachedMarkdown(key: string) {
  return cache.get(key)
}

export function touchCachedMarkdown(key: string, value: MarkdownCacheEntry) {
  cache.delete(key)
  cache.set(key, value)

  if (cache.size <= max) return

  const first = cache.keys().next().value
  if (!first) return
  cache.delete(first)
}

export async function preloadMarkdown(
  text: string,
  cacheKey: string,
  parser: { parse(text: string): string | Promise<string> },
) {
  await Promise.all(
    project(undefined, text, false).blocks.map(async (block, index) => {
      if (block.mode === "code") return
      const key = `${cacheKey}:${index}:${block.mode}`
      const cached = getCachedMarkdown(key)
      if (cached?.raw === block.raw) {
        touchCachedMarkdown(key, cached)
        return
      }
      const hash = checksum(block.raw)
      if (!hash) return
      touchCachedMarkdown(key, {
        raw: block.raw,
        hash,
        html: sanitizeMarkdown(await Promise.resolve(parser.parse(block.src))),
      })
    }),
  )
}
