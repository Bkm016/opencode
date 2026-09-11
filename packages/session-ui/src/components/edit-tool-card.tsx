import { createSignal, createMemo, Show, type JSX } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { TextShimmer } from "@opencode-ai/ui/text-shimmer"
import { DiffChanges } from "@opencode-ai/ui/diff-changes"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import "./edit-tool-card.css"

export interface EditToolCardProps {
  actionTitle: string
  filePath?: string
  status?: string
  defaultOpen?: boolean
  fileDiff?: { additions: number; deletions: number }
  onViewFile?: (filePath: string) => void
  children?: JSX.Element
}

export function EditToolCard(props: EditToolCardProps) {
  const i18n = useI18n()
  const pending = () => props.status === "pending" || props.status === "running"
  const [open, setOpen] = createSignal(props.defaultOpen ?? pending())

  const filename = createMemo(() => getFilename(props.filePath ?? ""))
  const dir = createMemo(() => (props.filePath?.includes("/") ? getDirectory(props.filePath) : ""))

  return (
    <div class="edit-tool-card" data-component="edit-tool-card">
      <div
        class="edit-tool-card-trigger"
        role="button"
        tabIndex={0}
        onClick={() => setOpen(!open())}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            setOpen(!open())
          }
        }}
      >
        <div class="edit-tool-card-info">
          <span class="edit-tool-card-icon">
            <Icon name="code-lines" size="small" />
          </span>
          <span class="edit-tool-card-action">
            <TextShimmer text={props.actionTitle} active={pending()} />
          </span>
          <Show when={filename()}>
            <span class="edit-tool-card-filename">{filename()}</span>
          </Show>
          <Show when={dir()}>
            <span class="edit-tool-card-dir">{dir()}</span>
          </Show>
        </div>

        <div class="edit-tool-card-tail" onClick={(e) => e.stopPropagation()}>
          <Show when={!pending() && props.fileDiff}>
            <DiffChanges changes={props.fileDiff!} />
          </Show>
          <Show when={props.onViewFile && props.filePath}>
            <Tooltip value={i18n.t("ui.sessionReview.openFile")} placement="top" gutter={4}>
              <button
                class="edit-tool-card-open-btn"
                type="button"
                aria-label={i18n.t("ui.sessionReview.openFile")}
                onClick={() => props.onViewFile?.(props.filePath!)}
              >
                <Icon name="open-file" size="small" />
              </button>
            </Tooltip>
          </Show>
          <span class="edit-tool-card-arrow" data-open={open() ? "true" : "false"}>
            <Icon name="chevron-down" size="small" />
          </span>
        </div>
      </div>

      <div class="edit-tool-card-body-wrapper" data-open={open() ? "true" : "false"}>
        <div class="edit-tool-card-body-inner">
          <div class="edit-tool-card-content">{props.children}</div>
        </div>
      </div>
    </div>
  )
}
