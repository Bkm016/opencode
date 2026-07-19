import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tag } from "@opencode-ai/ui/tag"
import { TextField } from "@opencode-ai/ui/text-field"
import { useFilteredList } from "@opencode-ai/ui/hooks"
import { type Component, For, Show, createEffect, createMemo, createResource, createSignal } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { SettingsList } from "./settings-list"
import { SettingsServerPicker, SettingsServerScope } from "./settings-server-picker"

type InstructionEntry = {
  source: string
  content: string
}

type InstructionItem = InstructionEntry & {
  id: string
  isURL: boolean
}

function isURL(source: string) {
  return source.startsWith("https://") || source.startsWith("http://")
}

async function loadInstructions(
  sdk: ReturnType<ReturnType<typeof useServerSDK>>,
): Promise<InstructionEntry[] | undefined> {
  try {
    const result = await sdk.client.config.instructions()
    if (result.error || !Array.isArray(result.data)) return undefined
    return result.data.filter(
      (row): row is InstructionEntry =>
        !!row && typeof row === "object" && typeof row.source === "string" && typeof row.content === "string",
    )
  } catch {
    return undefined
  }
}

function copyText(text: string) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text)
  return Promise.reject(new Error("Clipboard unavailable"))
}

export const SettingsInstructions: Component = () => {
  return (
    <SettingsServerScope>
      <SettingsInstructionsContent />
    </SettingsServerScope>
  )
}

const SettingsInstructionsContent: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const server = useServer()
  const serverSDK = useServerSDK()
  const [selectedID, setSelectedID] = createSignal<string>()
  const [copied, setCopied] = createSignal(false)

  const [remote] = createResource(
    () => serverSDK(),
    (sdk) => loadInstructions(sdk),
  )

  const items = createMemo<InstructionItem[]>(() => {
    const entries = remote()
    if (!entries || entries.length === 0) return []
    return entries.map((entry) => ({
      ...entry,
      id: entry.source,
      isURL: isURL(entry.source),
    }))
  })

  const list = useFilteredList<InstructionItem>({
    items: () => items(),
    key: (item) => item.id,
    filterKeys: ["source"],
  })

  const selected = createMemo(() => {
    const id = selectedID()
    if (!id) return undefined
    return items().find((item) => item.id === id)
  })

  // 与 prompts 面板一致:未选中时默认落到第一项,避免右侧空白
  createEffect(() => {
    if (selectedID()) return
    const first = list.flat()[0]
    if (first) setSelectedID(first.id)
  })

  const copy = async () => {
    const item = selected()
    if (!item) return
    try {
      await copyText(item.content)
      setCopied(true)
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("settings.instructions.copied"),
      })
      setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // 用系统默认编辑器打开本地指令文件;远程 URL 不适用
  const canOpenFile = createMemo(() => !!platform.openPath && server.isLocal())

  const openFile = () => {
    const item = selected()
    if (!item || item.isURL || !platform.openPath || !canOpenFile()) return
    platform.openPath(item.source).catch((err: unknown) =>
      showToast({
        variant: "error",
        title: language.t("settings.instructions.openFile"),
        description: err instanceof Error ? err.message : String(err),
      }),
    )
  }

  return (
    <div class="flex flex-col h-full overflow-hidden">
      <div class="flex flex-col gap-4 px-4 pt-6 pb-4 sm:px-10 shrink-0">
        <div class="flex items-center justify-between gap-4 max-w-[960px]">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.tab.instructions")}</h2>
          <SettingsServerPicker />
        </div>
        <div class="flex items-center gap-2 px-3 h-9 rounded-lg bg-surface-base max-w-[960px]">
          <Icon name="magnifying-glass" class="text-icon-weak-base flex-shrink-0" />
          <TextField
            variant="ghost"
            type="text"
            value={list.filter()}
            onChange={list.onInput}
            placeholder={language.t("settings.instructions.title")}
            spellcheck={false}
            autocorrect="off"
            autocomplete="off"
            autocapitalize="off"
            class="flex-1"
          />
          <Show when={list.filter()}>
            <IconButton icon="circle-x" variant="ghost" onClick={list.clear} />
          </Show>
        </div>
      </div>

      <div class="flex flex-1 min-h-0 gap-4 px-4 pb-6 sm:px-10 max-w-[960px] w-full overflow-hidden">
        <div class="w-[240px] shrink-0 flex flex-col min-h-0 overflow-y-auto no-scrollbar">
          <Show
            when={!remote.loading && list.flat().length > 0}
            fallback={
              <div class="flex flex-col items-center justify-center py-12 text-center px-2">
                <span class="text-14-regular text-text-weak">
                  {remote.loading
                    ? language.t("settings.instructions.loading")
                    : remote.error || remote() === undefined
                      ? language.t("settings.instructions.error")
                      : language.t("settings.instructions.empty")}
                </span>
                <Show when={!remote.loading && list.filter()}>
                  <span class="text-14-regular text-text-strong mt-1">&quot;{list.filter()}&quot;</span>
                </Show>
              </div>
            }
          >
            <SettingsList>
              <For each={list.flat()}>
                {(item) => {
                  const active = () => selectedID() === item.id
                  return (
                    <button
                      type="button"
                      classList={{
                        "w-full text-left flex items-center justify-between gap-2 py-2.5 px-1 border-b border-border-weak-base last:border-none transition-colors":
                          true,
                        "text-text-strong": active(),
                        "text-text-weak hover:text-text-strong": !active(),
                      }}
                      onClick={() => setSelectedID(item.id)}
                    >
                      <span class="text-13-regular truncate min-w-0">{item.source}</span>
                      <Show when={item.isURL}>
                        <Tag class="shrink-0">{language.t("settings.instructions.badge.url")}</Tag>
                      </Show>
                    </button>
                  )
                }}
              </For>
            </SettingsList>
          </Show>
        </div>

        <div class="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
          <Show
            when={selected()}
            fallback={
              <div class="flex flex-col items-center justify-center h-full text-center">
                <span class="text-14-regular text-text-weak">
                  {remote.loading
                    ? language.t("settings.instructions.loading")
                    : items().length === 0
                      ? language.t("settings.instructions.empty")
                      : language.t("settings.instructions.title")}
                </span>
              </div>
            }
          >
            {(item) => (
              <div class="flex flex-col h-full min-h-0 gap-3 overflow-hidden">
                <div class="flex flex-col gap-1 shrink-0">
                  <div class="flex items-center gap-2 flex-wrap">
                    <h3 class="text-14-medium text-text-strong break-all">{item().source}</h3>
                    <Show when={item().isURL}>
                      <Tag>{language.t("settings.instructions.badge.url")}</Tag>
                    </Show>
                  </div>
                  <span class="text-13-regular text-text-weak">{language.t("settings.instructions.description")}</span>
                </div>

                <div class="flex-1 min-h-0 min-w-0 overflow-hidden rounded-md border border-border-weak-base bg-surface-base">
                  <textarea
                    value={item().content}
                    spellcheck={false}
                    autocomplete="off"
                    autocapitalize="off"
                    readonly
                    class="block w-full h-full min-h-0 p-3 font-mono text-12-regular text-text-strong bg-transparent border-0 outline-none resize-none overflow-y-auto no-scrollbar"
                    aria-label={language.t("settings.instructions.title")}
                  />
                </div>

                <div class="flex items-center justify-end gap-2 shrink-0 pt-1">
                  <Show when={canOpenFile() && !item().isURL}>
                    <Button size="small" variant="ghost" onClick={() => openFile()}>
                      {language.t("settings.instructions.openFile")}
                    </Button>
                  </Show>
                  <Button size="small" variant="ghost" onClick={() => void copy()}>
                    {copied()
                      ? language.t("settings.instructions.copied")
                      : language.t("settings.instructions.copy")}
                  </Button>
                </div>
              </div>
            )}
          </Show>
        </div>
      </div>
    </div>
  )
}