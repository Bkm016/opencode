import { For, Show } from "solid-js"
import { BasicTool } from "./basic-tool"
import { Button } from "@opencode-ai/ui/button"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { useCanvas, type CanvasReference } from "../context/canvas"
import { Icon } from "@opencode-ai/ui/icon"
import type { ToolProps } from "./message-part"

export function CanvasTool(props: ToolProps) {
  const i18n = useI18n()
  const present = useCanvas()
  const path = () => String(props.metadata.path ?? props.input.path ?? "")
  const title = () => String(props.metadata.title ?? props.input.title ?? path())
  const completed = () => props.status === "completed"
  const label = () =>
    i18n.t(props.status === "error" ? "ui.canvas.failed" : completed() ? "ui.canvas.ready" : "ui.canvas.opening")

  return (
    <BasicTool
      {...props}
      icon="window-cursor"
      trigger={{
        title: label(),
        subtitle: title(),
        action: (
          <Show when={completed() && present && props.sessionID && props.partID && props.messageID}>
            <Button
              size="small"
              variant="ghost"
              onClick={(event: MouseEvent) => {
                event.stopPropagation()
                if (!props.sessionID || !props.partID || !props.messageID) return
                present?.(props.sessionID, {
                  partID: props.partID,
                  messageID: props.messageID,
                  path: path(),
                  title: title(),
                })
              }}
            >
              {i18n.t("ui.canvas.open")}
            </Button>
          </Show>
        ),
      }}
    >
      <div class="px-3 py-2 text-12-regular break-words text-text-weak">
        <Show when={props.status === "error"} fallback={path()}>
          <span role="alert">{props.error}</span>
        </Show>
      </div>
    </BasicTool>
  )
}

export function CanvasSummary(props: { sessionID: string; canvases: CanvasReference[] }) {
  const present = useCanvas()
  const i18n = useI18n()

  return (
    <div data-component="canvas-summary" class="flex flex-wrap items-center gap-x-5 gap-y-1 py-2">
      <For each={props.canvases}>
        {(canvas) => (
          <button
            type="button"
            class="inline-flex min-w-0 max-w-full items-center gap-1.5 border-0 bg-transparent px-0 py-1 text-12-regular text-text-weak hover:text-text-strong focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 disabled:opacity-50"
            disabled={!present}
            title={canvas.path}
            aria-label={`${i18n.t("ui.canvas.open")}: ${canvas.title || canvas.path}`}
            onClick={() => present?.(props.sessionID, canvas)}
          >
            <Icon name="window-cursor" size="small" />
            <span class="truncate">{canvas.title || canvas.path}</span>
            <Icon name="chevron-right" size="small" />
          </button>
        )}
      </For>
    </div>
  )
}
