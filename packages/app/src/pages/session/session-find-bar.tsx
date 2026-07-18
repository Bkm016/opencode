import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { type Component, Show, createEffect, on } from "solid-js"
import { useLanguage } from "@/context/language"

export type SessionFindBarProps = {
  open: boolean
  focusToken?: number
  query: string
  matchIndex: number
  matchCount: number
  onQuery: (value: string) => void
  onClose: () => void
  onNext: () => void
  onPrev: () => void
}

export const SessionFindBar: Component<SessionFindBarProps> = (props) => {
  const language = useLanguage()
  let input: HTMLInputElement | undefined

  createEffect(
    on(
      () => [props.open, props.focusToken] as const,
      ([open]) => {
        if (!open) return
        requestAnimationFrame(() => {
          input?.focus()
          input?.select()
        })
      },
    ),
  )

  const counter = () => {
    if (!props.query) return ""
    if (props.matchCount === 0) return language.t("session.find.none")
    return language.t("session.find.count", {
      current: String(props.matchIndex + 1),
      total: String(props.matchCount),
    })
  }

  return (
    <Show when={props.open}>
      <div
        class="pointer-events-none absolute inset-x-0 top-3 z-40 flex justify-center px-3"
        data-component="session-find-bar"
      >
        <div class="pointer-events-auto flex items-center gap-1 h-9 max-w-[min(440px,calc(100%-1.5rem))] w-full rounded-lg border border-border-weak-base bg-[var(--v2-background-bg-layer-01,var(--surface-raised-stronger-non-alpha))] px-1.5 shadow-[var(--v2-elevation-floating,var(--shadow-md))]">
          <Icon name="magnifying-glass" class="text-icon-weak-base shrink-0 ml-1" />
          <input
            ref={(el) => {
              input = el
            }}
            type="text"
            value={props.query}
            onInput={(event) => props.onQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault()
                event.stopPropagation()
                props.onClose()
                return
              }
              if (event.key === "Enter") {
                event.preventDefault()
                event.stopPropagation()
                if (event.shiftKey) props.onPrev()
                else props.onNext()
              }
            }}
            placeholder={language.t("session.find.placeholder")}
            spellcheck={false}
            autocomplete="off"
            autocapitalize="off"
            class="flex-1 min-w-0 h-full bg-transparent border-0 outline-none text-13-regular text-text-strong placeholder:text-text-weak"
            aria-label={language.t("session.find.placeholder")}
          />
          <span class="shrink-0 text-12-regular text-text-weak tabular-nums px-1 min-w-[4.5rem] text-right">
            {counter()}
          </span>
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
