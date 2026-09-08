// 使用普通 Markdown 锚点承载引用，不要求聊天渲染器放行自定义 URL 协议。
export const CANVAS_LINK_PREFIX = "#canvas?"

export function readCanvasLink(href: string) {
  if (!href.startsWith(CANVAS_LINK_PREFIX)) return
  const params = new URLSearchParams(href.slice(CANVAS_LINK_PREFIX.length))
  const sessionID = params.get("sessionID")
  const path = params.get("path")
  if (!sessionID || !path) return
  return { sessionID, path }
}
