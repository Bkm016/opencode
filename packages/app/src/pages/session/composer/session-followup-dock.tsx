import { For, Show, createEffect, createMemo, on } from "solid-js"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useLanguage } from "@/context/language"
import { useComposerTabs } from "./session-composer-tabs"

export function SessionFollowupDock(props: {
  items: { id: string; text: string }[]
  sending?: string
  onSend: (id: string) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
}) {
  const language = useLanguage()
  const tabs = useComposerTabs()
  const total = createMemo(() => props.items.length)

  // 排队消息是用户刚发出的，新增一条时切过来并展开，方便确认/编辑（刷新页面恢复的不自动展开）
  tabs.use(() => total() > 0, {
    id: "queue",
    order: 4,
    label: () => language.t("session.composerTabs.queue"),
    meta: () => String(total()),
    preview: () => props.items[0]?.text,
  })
  createEffect(
    on(total, (count, prev) => {
      if (count > (prev ?? 0)) tabs.notify("queue", { open: prev !== undefined })
    }),
  )

  return (
    <Show when={total() > 0 && tabs.active("queue")}>
      <div data-component="session-followup-dock">
        <div class="flex flex-col max-h-48 overflow-y-auto overscroll-contain no-scrollbar">
          <For each={props.items}>
            {(item) => (
              <div
                data-slot="followup-item"
                class="group/row h-8 pl-1.5 pr-0.5 flex items-center gap-2 min-w-0 rounded-md hover:bg-surface-raised-base-hover"
              >
                <span class="min-w-0 flex-1 truncate text-13-regular text-text-base group-hover/row:text-text-strong">
                  {item.text}
                </span>
                <Show
                  when={props.sending !== item.id}
                  fallback={
                    <div class="size-6 shrink-0 flex items-center justify-center">
                      <Spinner class="size-3.5 text-icon-weak" />
                    </div>
                  }
                >
                  {/* 操作只在悬停时出现；纯触屏没有悬停，常显 */}
                  <div class="shrink-0 flex items-center opacity-0 transition-opacity duration-100 group-hover/row:opacity-100 group-focus-within/row:opacity-100 [@media(hover:none)]:opacity-100">
                    <Tooltip placement="top" value={language.t("session.followupDock.steer")}>
                      <IconButton
                        data-action="followup-steer"
                        icon="arrow-up"
                        size="small"
                        variant="ghost"
                        disabled={!!props.sending}
                        aria-label={language.t("session.followupDock.steer")}
                        onClick={() => props.onSend(item.id)}
                      />
                    </Tooltip>
                    <Tooltip placement="top" value={language.t("session.followupDock.edit")}>
                      <IconButton
                        data-action="followup-edit"
                        icon="pencil-line"
                        size="small"
                        variant="ghost"
                        disabled={!!props.sending}
                        aria-label={language.t("session.followupDock.edit")}
                        onClick={() => props.onEdit(item.id)}
                      />
                    </Tooltip>
                    <Tooltip placement="top" value={language.t("session.followupDock.delete")}>
                      <IconButton
                        data-action="followup-delete"
                        icon="close-small"
                        size="small"
                        variant="ghost"
                        aria-label={language.t("session.followupDock.delete")}
                        onClick={() => props.onDelete(item.id)}
                      />
                    </Tooltip>
                  </div>
                </Show>
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  )
}
