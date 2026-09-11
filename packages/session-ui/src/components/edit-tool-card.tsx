import { createSignal, createMemo, createEffect, onCleanup, Show, For, Switch, Match, type JSX } from "solid-js"
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
          <Show when={open()}>
            <div class="edit-tool-card-content">{props.children}</div>
          </Show>
        </div>
      </div>
    </div>
  )
}

export interface MultiEditFileItem {
  relativePath: string
  filePath: string
  type?: string
  additions: number
  deletions: number
  renderContent: () => JSX.Element
}

export interface MultiEditToolCardProps {
  actionTitle: string
  status?: string
  defaultOpen?: boolean
  files: MultiEditFileItem[]
  onViewFile?: (filePath: string) => void
}

export function MultiEditToolCard(props: MultiEditToolCardProps) {
  const i18n = useI18n()
  const pending = () => props.status === "pending" || props.status === "running"
  const [open, setOpen] = createSignal(props.defaultOpen ?? pending())

  // 子文件折叠状态：默认全部展开
  const [collapsedFiles, setCollapsedFiles] = createSignal<Record<string, boolean>>({})
  const toggleFile = (path: string) => {
    setCollapsedFiles((prev) => ({ ...prev, [path]: !prev[path] }))
  }

  const totalAdditions = createMemo(() => props.files.reduce((sum, f) => sum + (f.additions || 0), 0))
  const totalDeletions = createMemo(() => props.files.reduce((sum, f) => sum + (f.deletions || 0), 0))

  const countSummary = createMemo(() => {
    const c = props.files.length
    if (c === 0) return ""
    return `${c} ${i18n.t(c > 1 ? "ui.common.file.other" : "ui.common.file.one")}`
  })

  return (
    <div class="edit-tool-card" data-component="multi-edit-tool-card">
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
          <span class="edit-tool-card-action">
            <TextShimmer text={props.actionTitle} active={pending()} />
          </span>
          <Show when={countSummary()}>
            <span class="edit-tool-card-summary">{countSummary()}</span>
          </Show>
        </div>

        <div class="edit-tool-card-tail" onClick={(e) => e.stopPropagation()}>
          <Show when={!pending() && (totalAdditions() > 0 || totalDeletions() > 0)}>
            <DiffChanges changes={{ additions: totalAdditions(), deletions: totalDeletions() }} />
          </Show>
          <span class="edit-tool-card-arrow" data-open={open() ? "true" : "false"}>
            <Icon name="chevron-down" size="small" />
          </span>
        </div>
      </div>

      <div class="edit-tool-card-body-wrapper" data-open={open() ? "true" : "false"}>
        <div class="edit-tool-card-body-inner">
          <Show when={open()}>
            <div class="multi-edit-file-list">
              <For each={props.files}>
                {(file) => {
                  const isItemOpen = () => !collapsedFiles()[file.relativePath]
                  return (
                    <div class="multi-edit-file-item">
                      {/* 子文件 Header：无粘性定位，纯整齐卡片头部 */}
                      <div
                        class="multi-edit-file-header"
                        role="button"
                        tabIndex={0}
                        onClick={() => toggleFile(file.relativePath)}
                      >
                        <div class="multi-edit-file-info">
                          <span class="multi-edit-file-name">{getFilename(file.relativePath)}</span>
                          <Show when={file.relativePath.includes("/")}>
                            <span class="multi-edit-file-dir">{getDirectory(file.relativePath)}</span>
                          </Show>
                        </div>

                        <div class="multi-edit-file-actions" onClick={(e) => e.stopPropagation()}>
                          <Switch>
                            <Match when={pending()}>
                              <DiffChanges changes={{ additions: file.additions, deletions: file.deletions }} />
                            </Match>
                            <Match when={file.type === "add"}>
                              <span class="multi-edit-badge" data-type="added">
                                {i18n.t("ui.patch.action.created")}
                              </span>
                            </Match>
                            <Match when={file.type === "delete"}>
                              <span class="multi-edit-badge" data-type="removed">
                                {i18n.t("ui.patch.action.deleted")}
                              </span>
                            </Match>
                            <Match when={file.type === "move"}>
                              <span class="multi-edit-badge" data-type="modified">
                                {i18n.t("ui.patch.action.moved")}
                              </span>
                            </Match>
                            <Match when={true}>
                              <DiffChanges changes={{ additions: file.additions, deletions: file.deletions }} />
                            </Match>
                          </Switch>

                          <Show when={props.onViewFile && file.filePath}>
                            <Tooltip value={i18n.t("ui.sessionReview.openFile")} placement="top" gutter={4}>
                              <button
                                class="edit-tool-card-open-btn"
                                type="button"
                                aria-label={i18n.t("ui.sessionReview.openFile")}
                                onClick={() => props.onViewFile?.(file.filePath)}
                              >
                                <Icon name="open-file" size="small" />
                              </button>
                            </Tooltip>
                          </Show>

                          <span class="edit-tool-card-arrow" data-open={isItemOpen() ? "true" : "false"}>
                            <Icon name="chevron-down" size="small" />
                          </span>
                        </div>
                      </div>

                      <div class="edit-tool-card-body-wrapper" data-open={isItemOpen() ? "true" : "false"}>
                        <div class="edit-tool-card-body-inner">
                          <Show when={isItemOpen()}>
                            <div class="edit-tool-card-content">{file.renderContent()}</div>
                          </Show>
                        </div>
                      </div>
                    </div>
                  )
                }}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </div>
  )
}
