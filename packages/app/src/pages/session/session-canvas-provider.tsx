import { createEffect, onCleanup, untrack, type ParentProps } from "solid-js"
import { CanvasContext, CanvasLinks, type CanvasReference } from "@opencode-ai/session-ui/context/canvas"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useSessionLayout } from "./session-layout"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"

export function SessionCanvasProvider(props: ParentProps) {
  const sdk = useSDK()
  const sync = useSync()
  const language = useLanguage()
  const { params, view, sessionKey } = useSessionLayout()
  const presented = new Map<string, Set<string>>()
  const present = (sessionID: string, canvas: CanvasReference) => {
    if (sessionID !== params.id) return
    view().canvas.open(canvas)
  }

  createEffect(() => {
    const sessionID = params.id
    const client = sdk()
    const key = sessionKey()
    const seen = presented.get(key) ?? new Set<string>()
    presented.set(key, seen)
    untrack(() => {
      for (const message of sync().data.message[sessionID ?? ""] ?? []) {
        for (const part of sync().data.part[message.id] ?? []) {
          if (part.type === "tool" && part.tool === "canvas" && part.state.status === "completed") seen.add(part.id)
        }
      }
    })
    // 只响应当前订阅期间新完成的调用；历史加载、切换会话和事件重放不得抢走面板。
    onCleanup(
      client.event.on("message.part.updated", (event) => {
        const part = event.properties.part
        if (part.sessionID !== sessionID || part.type !== "tool" || part.tool !== "canvas") return
        // SSE 可能合并 running/completed，只依赖完成事件，不要求先收到 running。
        if (part.state.status !== "completed" || seen.has(part.id)) return
        seen.add(part.id)
        if (view().canvas.get()?.partID === part.id) return
        const meta = part.state.metadata
        if (typeof meta.path !== "string" || typeof meta.title !== "string") return
        present(part.sessionID, { partID: part.id, messageID: part.messageID, path: meta.path, title: meta.title })
      }),
    )
  })

  return (
    <CanvasContext.Provider value={present}>
      <CanvasLinks
        sessionID={params.id}
        parts={() =>
          (sync().data.message[params.id ?? ""] ?? []).flatMap((message) => sync().data.part[message.id] ?? [])
        }
        onUnavailable={() =>
          showToast({
            title: language.t("ui.canvas.failed"),
            description: language.t("ui.canvas.referenceUnavailable"),
          })
        }
      >
        {props.children}
      </CanvasLinks>
    </CanvasContext.Provider>
  )
}
