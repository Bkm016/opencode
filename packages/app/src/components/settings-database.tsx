import type { Path } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { type Component, For, Show, createMemo, createResource, createSignal } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { SettingsList } from "./settings-list"
import { SettingsServerPicker, SettingsServerScope } from "./settings-server-picker"

function formatBytes(value: number | undefined) {
  if (value === undefined) return "—"
  if (value < 1024) return `${value} B`
  const units = ["KB", "MB", "GB", "TB"]
  let size = value / 1024
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[unit]}`
}

function formatCount(value: number | undefined) {
  if (value === undefined) return "—"
  return value.toLocaleString()
}

export const SettingsDatabase: Component = () => {
  return (
    <SettingsServerScope>
      <SettingsDatabaseContent />
    </SettingsServerScope>
  )
}

const SettingsDatabaseContent: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const serverSDK = useServerSDK()
  const [copied, setCopied] = createSignal<string>()

  const [path, { refetch }] = createResource(
    () => serverSDK(),
    (sdk) =>
      sdk.client.path
        .get()
        .then((res) => res.data as Path | undefined)
        .catch(() => undefined),
    { initialValue: undefined },
  )

  const database = createMemo(() => path.latest?.database)
  const totalSize = createMemo(() => {
    const info = database()
    if (!info) return undefined
    return (info.size ?? 0) + (info.walSize ?? 0) + (info.shmSize ?? 0)
  })

  const copy = (value: string, key: string) => {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
    if (!clipboard?.writeText) return
    void clipboard.writeText(value).then(() => {
      setCopied(key)
      setTimeout(() => setCopied((current) => (current === key ? undefined : current)), 1500)
    })
  }

  const reveal = (target: string | undefined) => {
    if (!target || !platform.revealPath) return
    void platform.revealPath(target)
  }

  const PathRow: Component<{
    title: string
    value: string | undefined
    copyKey: string
    revealable?: boolean
  }> = (props) => {
    const value = () => props.value ?? "—"
    return (
      <div class="flex flex-wrap items-start gap-3 py-3 border-b border-border-weak-base last:border-none sm:flex-nowrap">
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="text-14-medium text-text-strong">{props.title}</span>
          <span class="text-12-regular text-text-weak break-all font-mono">{value()}</span>
        </div>
        <div class="flex w-full justify-end gap-2 sm:w-auto sm:shrink-0">
          <Show when={props.value}>
            <Button
              size="small"
              variant="ghost"
              onClick={() => copy(props.value!, props.copyKey)}
            >
              {copied() === props.copyKey
                ? language.t("settings.database.action.copied")
                : language.t("settings.database.action.copy")}
            </Button>
            <Show when={props.revealable && platform.revealPath}>
              <Button size="small" variant="ghost" onClick={() => reveal(props.value)}>
                {language.t("settings.database.action.reveal")}
              </Button>
            </Show>
          </Show>
        </div>
      </div>
    )
  }

  const StatRow: Component<{ title: string; value: string }> = (props) => {
    return (
      <div class="flex flex-wrap items-center gap-4 py-3 border-b border-border-weak-base last:border-none sm:flex-nowrap">
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="text-14-medium text-text-strong">{props.title}</span>
        </div>
        <div class="flex w-full justify-end sm:w-auto sm:shrink-0">
          <span class="text-12-regular text-text-weak font-mono">{props.value}</span>
        </div>
      </div>
    )
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-4 pt-6 pb-6 max-w-[720px]">
          <div class="flex items-center justify-between gap-4">
            <h2 class="text-16-medium text-text-strong">{language.t("settings.tab.database")}</h2>
            <div class="flex items-center gap-2">
              <SettingsServerPicker />
              <Button size="small" variant="ghost" onClick={() => void refetch()}>
                {language.t("settings.database.action.refresh")}
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div class="flex flex-col gap-8 w-full max-w-[720px]">
        <Show
          when={!path.loading || path.latest}
          fallback={
            <div class="flex flex-col items-center justify-center py-12 text-center">
              <span class="text-14-regular text-text-weak">{language.t("settings.database.loading")}</span>
            </div>
          }
        >
          <Show
            when={database()}
            fallback={
              <div class="flex flex-col items-center justify-center py-12 text-center">
                <span class="text-14-regular text-text-weak">{language.t("settings.database.unavailable")}</span>
              </div>
            }
          >
            {(info) => (
              <>
                <div class="flex flex-col gap-1">
                  <h3 class="text-14-medium text-text-strong pb-2">
                    {language.t("settings.database.section.storage")}
                  </h3>
                  <SettingsList>
                    <PathRow
                      title={language.t("settings.database.row.dbPath.title")}
                      value={info().path}
                      copyKey="db"
                      revealable
                    />
                    <PathRow
                      title={language.t("settings.database.row.dataDir.title")}
                      value={info().data}
                      copyKey="data"
                      revealable
                    />
                    <PathRow
                      title={language.t("settings.database.row.configDir.title")}
                      value={path.latest?.config}
                      copyKey="config"
                      revealable
                    />
                    <PathRow
                      title={language.t("settings.database.row.logDir.title")}
                      value={path.latest?.log}
                      copyKey="log"
                      revealable
                    />
                    <PathRow
                      title={language.t("settings.database.row.cacheDir.title")}
                      value={path.latest?.cache}
                      copyKey="cache"
                      revealable
                    />
                  </SettingsList>
                </div>

                <div class="flex flex-col gap-1">
                  <h3 class="text-14-medium text-text-strong pb-2">
                    {language.t("settings.database.section.stats")}
                  </h3>
                  <SettingsList>
                    <StatRow
                      title={language.t("settings.database.row.size.title")}
                      value={formatBytes(info().size)}
                    />
                    <StatRow
                      title={language.t("settings.database.row.walSize.title")}
                      value={formatBytes(info().walSize)}
                    />
                    <StatRow
                      title={language.t("settings.database.row.totalSize.title")}
                      value={formatBytes(totalSize())}
                    />
                    <StatRow
                      title={language.t("settings.database.row.journalMode.title")}
                      value={info().journalMode ?? "—"}
                    />
                    <StatRow
                      title={language.t("settings.database.row.pageCount.title")}
                      value={formatCount(info().pageCount)}
                    />
                    <StatRow
                      title={language.t("settings.database.row.pageSize.title")}
                      value={info().pageSize !== undefined ? formatBytes(info().pageSize) : "—"}
                    />
                    <StatRow
                      title={language.t("settings.database.row.freelist.title")}
                      value={formatCount(info().freelistCount)}
                    />
                  </SettingsList>
                </div>

                <div class="flex flex-col gap-1">
                  <h3 class="text-14-medium text-text-strong pb-2">
                    {language.t("settings.database.section.tables")}
                  </h3>
                  <SettingsList>
                    <For each={info().tables} fallback={
                      <div class="py-3 text-12-regular text-text-weak">
                        {language.t("settings.database.tables.empty")}
                      </div>
                    }>
                      {(table) => (
                        <div class="flex flex-wrap items-center gap-4 py-3 border-b border-border-weak-base last:border-none sm:flex-nowrap">
                          <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span class="text-14-medium text-text-strong font-mono">{table.name}</span>
                          </div>
                          <div class="flex w-full justify-end sm:w-auto sm:shrink-0">
                            <span class="text-12-regular text-text-weak font-mono">
                              {table.rows === undefined
                                ? language.t("settings.database.tables.rowsUnknown")
                                : language.t("settings.database.tables.rows", {
                                    count: formatCount(table.rows),
                                  })}
                            </span>
                          </div>
                        </div>
                      )}
                    </For>
                  </SettingsList>
                </div>
              </>
            )}
          </Show>
        </Show>
      </div>
    </div>
  )
}
