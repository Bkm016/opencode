import { Component, For, Match, Show, Switch } from "solid-js"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"

export type AtOption =
  | { type: "agent"; name: string; display: string }
  | {
      type: "resource"
      name: string
      uri: string
      client: string
      display: string
      description?: string
      mime?: string
    }
  | { type: "reference"; name: string; path: string; display: string; description: string }

export interface SlashCommand {
  id: string
  trigger: string
  title: string
  description?: string
  keybind?: string
  type: "builtin" | "custom"
  source?: "command" | "mcp" | "skill"
}

type PromptPopoverProps = {
  popover: "at" | "slash" | null
  setSlashPopoverRef: (el: HTMLDivElement) => void
  atFlat: AtOption[]
  atActive?: string
  atKey: (item: AtOption) => string
  setAtActive: (id: string) => void
  onAtSelect: (item: AtOption) => void
  slashFlat: SlashCommand[]
  slashActive?: string
  setSlashActive: (id: string) => void
  onSlashSelect: (item: SlashCommand) => void
  slashMenu: boolean
  slashMenuQuery: string
  onSlashMenuInput: (value: string) => void
  onSlashMenuKeyDown: (event: KeyboardEvent) => void
  commandKeybind: (id: string) => string | undefined
  commandKeybindParts: (id: string) => string[]
  t: (key: string) => string
}

export const PromptPopover: Component<PromptPopoverProps> = (props) => {
  return (
    <Show when={props.popover}>
      <div
        ref={(el) => {
          if (props.popover === "slash") props.setSlashPopoverRef(el)
        }}
        class="absolute inset-x-0 -top-2 -translate-y-full origin-bottom-left max-h-80 min-h-10
                 overflow-auto no-scrollbar flex flex-col p-2 rounded-[12px] bg-surface-raised-stronger-non-alpha shadow-[var(--shadow-lg-border-base)]"
        onMouseDown={(e) => e.preventDefault()}
      >
        <Switch>
          <Match when={props.popover === "at"}>
            <Show
              when={props.atFlat.length > 0}
              fallback={<div class="px-2 py-1 text-text-weak">{props.t("prompt.popover.emptyResults")}</div>}
            >
              <For each={props.atFlat.slice(0, 10)}>
                {(item) => {
                  const key = props.atKey(item)

                  if (item.type === "agent") {
                    return (
                      <button
                        class="w-full flex items-center gap-x-2 px-2 py-0.5 rounded-md"
                        classList={{
                          "bg-surface-raised-base-hover": props.atActive === key,
                        }}
                        onClick={() => props.onAtSelect(item)}
                        onPointerMove={() => props.setAtActive(key)}
                      >
                        <Icon name="brain" size="small" class="text-icon-info-active shrink-0" />
                        <span class="whitespace-nowrap text-14-regular text-text-strong">@{item.name}</span>
                      </button>
                    )
                  }

                  if (item.type === "resource") {
                    return (
                      <button
                        class="w-full flex items-center gap-x-2 px-2 py-0.5 rounded-md"
                        classList={{
                          "bg-surface-raised-base-hover": props.atActive === key,
                        }}
                        onClick={() => props.onAtSelect(item)}
                        onPointerMove={() => props.setAtActive(key)}
                      >
                        <FileIcon node={{ path: item.uri, type: "file" }} class="shrink-0 size-4" />
                        <div class="flex items-center min-w-0 text-14-regular">
                          <span class="text-text-strong whitespace-nowrap">@{item.name}</span>
                          <Show when={item.description}>
                            {(description) => (
                              <span class="whitespace-nowrap truncate min-w-0 ml-2 text-text-weak">{description()}</span>
                            )}
                          </Show>
                        </div>
                      </button>
                    )
                  }

                  if (item.type === "reference") {
                    return (
                      <button
                        class="w-full flex items-center gap-x-2 px-2 py-0.5 rounded-md"
                        classList={{
                          "bg-surface-raised-base-hover": props.atActive === key,
                        }}
                        onClick={() => props.onAtSelect(item)}
                        onPointerMove={() => props.setAtActive(key)}
                      >
                        <FileIcon node={{ path: item.path, type: "directory" }} class="shrink-0 size-4" />
                        <div class="flex items-center min-w-0 text-14-regular">
                          <span class="text-text-strong whitespace-nowrap">@{item.name}</span>
                          <span class="whitespace-nowrap truncate min-w-0 ml-2 text-text-weak">{item.description}</span>
                        </div>
                      </button>
                    )
                  }

                }}
              </For>
            </Show>
          </Match>
          <Match when={props.popover === "slash"}>
            <Show when={props.slashMenu}>
              <div class="px-2 py-1">
                <input
                  ref={(el) => requestAnimationFrame(() => el.focus())}
                  value={props.slashMenuQuery}
                  onInput={(event) => props.onSlashMenuInput(event.currentTarget.value)}
                  onKeyDown={props.onSlashMenuKeyDown}
                  onMouseDown={(event) => event.stopPropagation()}
                  aria-label={props.t("prompt.menu.commands")}
                  placeholder="/"
                  class="w-full bg-transparent outline-none text-[13px] leading-5 text-text-strong placeholder:text-text-weaker"
                />
              </div>
            </Show>
            <Show
              when={props.slashFlat.length > 0}
              fallback={<div class="px-2 py-1 text-text-weak">{props.t("prompt.popover.emptyCommands")}</div>}
            >
              <For each={props.slashFlat}>
                {(cmd) => {
                  const keybind = () => props.commandKeybind(cmd.id)
                  return (
                    <button
                      data-slash-id={cmd.id}
                      classList={{
                        "w-full flex items-center justify-between gap-4 px-2 py-1 rounded-md": true,
                        "bg-surface-raised-base-hover": props.slashActive === cmd.id,
                      }}
                      onClick={() => props.onSlashSelect(cmd)}
                      onPointerMove={() => props.setSlashActive(cmd.id)}
                    >
                      <div class="flex items-center gap-2 min-w-0">
                        <span class="whitespace-nowrap text-14-regular text-text-strong">/{cmd.trigger}</span>
                        <Show when={cmd.description}>
                          <span class="truncate text-14-regular text-text-weak">{cmd.description}</span>
                        </Show>
                      </div>
                      <div class="flex items-center gap-2 shrink-0">
                        <Show when={cmd.type === "custom" && cmd.source !== "command"}>
                          <span class="text-11-regular px-1.5 py-0.5 rounded bg-surface-base text-text-subtle">
                            {cmd.source === "skill"
                              ? props.t("prompt.slash.badge.skill")
                              : cmd.source === "mcp"
                                ? props.t("prompt.slash.badge.mcp")
                                : props.t("prompt.slash.badge.custom")}
                          </span>
                        </Show>
                        <Show when={keybind()}>
                          <span class="text-12-regular text-text-subtle">{keybind()}</span>
                        </Show>
                      </div>
                    </button>
                  )
                }}
              </For>
            </Show>
          </Match>
        </Switch>
      </div>
    </Show>
  )
}
