import { createContext, useContext, type ParentProps } from "solid-js"
import type { Part } from "@opencode-ai/sdk/v2"
import { CANVAS_LINK_PREFIX, readCanvasLink } from "@opencode-ai/core/util/canvas-link"

export type CanvasReference = {
  partID: string
  messageID: string
  path: string
  title: string
}

// 工具卡片只请求宿主展示，避免把桌面布局依赖引入共享时间线。
export const CanvasContext = createContext<(sessionID: string, canvas: CanvasReference) => void>()
export const useCanvas = () => useContext(CanvasContext)

export function CanvasLinks(
  props: ParentProps<{
    sessionID: string | undefined
    parts: () => readonly Part[]
    onUnavailable: () => void
  }>,
) {
  const present = useCanvas()

  return (
    <div
      style={{ display: "contents" }}
      on:click={{
        capture: true,
        handleEvent: (event) => {
          const target = event.target
          if (!(target instanceof Element)) return
          const href = target.closest("a")?.getAttribute("href")
          if (!href?.startsWith(CANVAS_LINK_PREFIX)) return
          // 抢在路由和外链处理前消费引用；失效链接也不得改变 URL 或导航到文件。
          event.preventDefault()
          event.stopPropagation()
          const ref = readCanvasLink(href)
          if (!present || !ref || ref.sessionID !== props.sessionID) return props.onUnavailable()
          // 只在点击时查找当前会话已授权的成功调用，同文件重复展示选择最新记录。
          const part = props
            .parts()
            .findLast(
              (part) =>
                part.sessionID === ref.sessionID &&
                part.type === "tool" &&
                part.tool === "canvas" &&
                part.state.status === "completed" &&
                part.state.metadata.path === ref.path,
            )
          if (!part || part.type !== "tool" || part.state.status !== "completed") return props.onUnavailable()
          const meta = part.state.metadata
          if (typeof meta.title !== "string") return props.onUnavailable()
          present(ref.sessionID, {
            partID: part.id,
            messageID: part.messageID,
            path: ref.path,
            title: meta.title,
          })
        },
      }}
    >
      {props.children}
    </div>
  )
}
