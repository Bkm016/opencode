import type { FilePart } from "@opencode-ai/sdk/v2"
import { ImagePreview } from "@opencode-ai/ui/image-preview"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { createMemo, For, Show } from "solid-js"
import { BasicTool } from "./basic-tool"
import type { ToolProps } from "./message-part"

/** OpenAI 原生生图工具的运行、完成与失败状态。 */
export function ImageGenerationTool(props: ToolProps) {
  const i18n = useI18n()
  const dialog = useDialog()
  const failed = createMemo(() => props.status === "error")
  const images = createMemo(() => (props.attachments ?? []).filter((file) => file.mime.startsWith("image/")))
  const prompt = createMemo(() => {
    const value = props.input.prompt ?? props.metadata.prompt
    return typeof value === "string" ? value : ""
  })

  const openImage = (file: FilePart) => {
    dialog.show(() => <ImagePreview src={file.url} alt={file.filename ?? i18n.t("ui.imagePreview.alt")} />)
  }

  return (
    <BasicTool
      {...props}
      icon="photo"
      defaultOpen={props.defaultOpen ?? true}
      trigger={{
        title: i18n.t("ui.tool.imageGeneration"),
        subtitle: prompt() || undefined,
        subtitleClass: "image-generation-tool-prompt",
      }}
    >
      <Show when={failed() && props.error}>
        <div data-component="image-generation-tool-error">{props.error}</div>
      </Show>
      <Show when={images().length > 0}>
        <div data-component="image-generation-tool-grid">
          <For each={images()}>
            {(file) => (
              <button
                type="button"
                data-slot="image-generation-tool-image"
                onClick={(event) => {
                  event.stopPropagation()
                  openImage(file)
                }}
              >
                <img src={file.url} alt={file.filename ?? i18n.t("ui.imagePreview.alt")} />
              </button>
            )}
          </For>
        </div>
      </Show>
    </BasicTool>
  )
}
