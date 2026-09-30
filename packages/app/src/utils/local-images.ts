import type { ServerConnection } from "@/context/server"

const LIMIT = 50

/**
 * 按路径从服务器取回图片并转成 data: URL：img 标签带不上服务器鉴权头，桌面端还会按 oc://renderer/ 解析相对路径；
 * 网页端 CSP 的 img-src 不含 blob:，data: 在两端都能显示。
 * 同一路径并发与重复渲染共用一次请求；失败的结果短暂缓存，避免流式重绘时反复请求。
 */
export function createLocalImages(input: { server: () => ServerConnection.Any; fetch?: typeof fetch }) {
  const cache = new Map<string, { value: Promise<string | undefined> }>()

  const load = async (server: ServerConnection.Any, directory: string, path: string) => {
    const http = server.http
    const url = new URL(`${http.url.replace(/\/+$/, "")}/experimental/file/raw`)
    url.searchParams.set("path", path)
    url.searchParams.set("directory", directory)
    const headers: Record<string, string> = { ...http.headers }
    if (http.password) headers.Authorization = `Basic ${btoa(`${http.username ?? "opencode"}:${http.password}`)}`
    const response = await (input.fetch ?? fetch)(url, { headers }).catch(() => undefined)
    if (!response?.ok) return
    const blob = await response.blob()
    if (!blob.type.startsWith("image/")) return
    return new Promise<string | undefined>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : undefined)
      reader.onerror = () => resolve(undefined)
      reader.readAsDataURL(blob)
    })
  }

  return {
    get(directory: string, path: string) {
      const server = input.server()
      const key = `${server.http.url}\0${directory}\0${path}`
      const hit = cache.get(key)
      if (hit) {
        cache.delete(key)
        cache.set(key, hit)
        return hit.value
      }
      const value = load(server, directory, path)
      cache.set(key, { value })
      // 取不到的图片 10 秒后允许重试（文件可能稍后才生成）
      void value.then((src) => {
        if (!src) setTimeout(() => cache.get(key)?.value === value && cache.delete(key), 10_000)
      })
      while (cache.size > LIMIT) {
        cache.delete(cache.keys().next().value!)
      }
      return value
    },
  }
}
