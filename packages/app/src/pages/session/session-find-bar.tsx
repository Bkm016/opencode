import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { type Component, Show } from "solid-js"
import { useLanguage } from "@/context/language"

// 从查找弹窗跳到对话后留在顶部的小胶囊：显示当前词和位置，可继续上下翻、重新打开弹窗或结束高亮
export type SessionFindBarProps = {
  open: boolean
  query: string
  matchIndex: number
  matchCount: number
  onReopen: () => void
  onClose: () => void
  onNext: () => void
  onPrev: () => void
}

export const SessionFindBar: Component<SessionFindBarProps> = (props) => {
  const language = useLanguage()
  return (
    <Show when={props.open}>
      <div
        class="pointer-events-none absolute inset-x-0 top-3 z-40 flex justify-center px-3"
        data-component="session-find-bar"
      >
        <div class="pointer-events-auto flex items-center gap-0.5 h-8 max-w-full rounded-full border border-border-weak-base bg-[var(--v2-background-bg-layer-01,var(--surface-raised-stronger-non-alpha))] pl-1 pr-1 shadow-[var(--v2-elevation-floating,var(--shadow-md))]">
          <button
            type="button"
            data-action="session-find-reopen"
            onClick={() => props.onReopen()}
            title={language.t("session.find.reopen")}
            class="flex items-center gap-1.5 h-6 min-w-0 rounded-full pl-2 pr-2.5 hover:bg-surface-raised-base-hover"
          >
            <Icon name="magnifying-glass" size="small" class="text-icon-base shrink-0" />
            <span class="truncate max-w-[16rem] text-13-medium text-text-strong">{props.query}</span>
            <span class="shrink-0 text-12-regular text-text-weak tabular-nums" data-slot="session-find-counter">
              {props.matchCount === 0
                ? language.t("session.find.none")
                : `${props.matchIndex + 1}/${props.matchCount}`}
            </span>
          </button>
          <IconButton
            icon="arrow-up"
            variant="ghost"
            size="small"
            onClick={() => props.onPrev()}
            disabled={props.matchCount === 0}
            aria-label={language.t("session.find.prev")}
          />
          <IconButton
            icon="arrow-up"
            variant="ghost"
            size="small"
            class="rotate-180"
            onClick={() => props.onNext()}
            disabled={props.matchCount === 0}
            aria-label={language.t("session.find.next")}
          />
          <IconButton
            icon="close"
            variant="ghost"
            size="small"
            onClick={() => props.onClose()}
            aria-label={language.t("session.find.close")}
          />
        </div>
      </div>
    </Show>
  )
}
