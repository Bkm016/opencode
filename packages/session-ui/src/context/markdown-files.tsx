import { createContext, useContext } from "solid-js"

/**
 * 消息 markdown 里引用本地文件（图片路径）时，由宿主应用负责取回内容：
 * 渲染层不知道服务器地址与鉴权，也不应让浏览器按页面 base（如 oc://renderer/）去解析相对路径。
 */
export type MarkdownFiles = {
  /** 返回可直接作为 img src 的地址（通常是 blob: URL）；取不到时返回 undefined。 */
  image(path: string): Promise<string | undefined>
  /** 点击图片时放大预览。 */
  preview?(src: string, alt?: string): void
}

const Context = createContext<MarkdownFiles>()

export const MarkdownFilesProvider = Context.Provider

export function useMarkdownFiles() {
  return useContext(Context)
}
