import type { Path, StorageBudget, StorageCompactResult } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Switch } from "@opencode-ai/ui/switch"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { type Component, For, Show, createMemo, createResource, createSignal } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
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

function databaseFootprint(info: StorageBudget["database"] | undefined) {
  if (!info) return 0
  return (info.size ?? 0) + (info.walSize ?? 0) + (info.shmSize ?? 0)
}

function compactReclaimed(result: StorageCompactResult | undefined) {
  if (!result) return 0
  const db = Math.max(0, databaseFootprint(result.before?.database) - databaseFootprint(result.after?.database))
  const tool = result.toolOutputBytes ?? 0
  const logs = result.logsBytes ?? 0
  return db + tool + logs
}

type CompactActions = {
  checkpoint: boolean
  vacuum: boolean
  toolOutput: boolean
  logs: boolean
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
  const dialog = useDialog()
  const [copied, setCopied] = createSignal<string>()
  const [actions, setActions] = createSignal<CompactActions>({
    checkpoint: true,
    vacuum: true,
    toolOutput: true,
    logs: true,
  })
  const [busy, setBusy] = createSignal(false)

  const [path, { refetch: refetchPath }] = createResource(
    () => serverSDK(),
    (sdk) =>
      sdk.client.path
        .get()
        .then((res) => res.data as Path | undefined)
        .catch(() => undefined),
    { initialValue: undefined },
  )

  const [budget, { refetch: refetchBudget }] = createResource(
    () => serverSDK(),
    (sdk) =>
      sdk.client.experimental.storage
        .get()
        .then((res) => res.data as StorageBudget | undefined)
        .catch(() => undefined),
    { initialValue: undefined },
  )

  const database = createMemo(() => path.latest?.database)
  const totalSize = createMemo(() => {
    const info = database()
    if (!info) return undefined
    return (info.size ?? 0) + (info.walSize ?? 0) + (info.shmSize ?? 0)
  })

  const selected = createMemo(() => {
    const current = actions()
    return current.checkpoint || current.vacuum || current.toolOutput || current.logs
  })

  const estimateBytes = createMemo(() => {
    const info = budget.latest
    if (!info) return 0
    const current = actions()
    let total = 0
    if (current.vacuum) total += info.database?.reclaimableBytes ?? 0
    if (current.checkpoint) total += info.database?.walSize ?? 0
    if (current.toolOutput) total += info.toolOutput?.expiredBytes ?? 0
    if (current.logs) total += info.logs?.expiredBytes ?? 0
    return total
  })

  const refresh = () => {
    void refetchPath()
    void refetchBudget()
  }

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

  const toggle = (key: keyof CompactActions) => {
    setActions((current) => ({ ...current, [key]: !current[key] }))
  }

  const runCompact = async () => {
    if (busy() || !selected()) return
    setBusy(true)
    try {
      const current = actions()
      const result = await serverSDK().client.experimental.storage.compact({
        checkpoint: current.checkpoint,
        vacuum: current.vacuum,
        toolOutput: current.toolOutput,
        logs: current.logs,
      })
      if (result.error) {
        showToast({
          variant: "error",
          title: language.t("settings.database.compact.toast.failed.title"),
          description: language.t("common.requestFailed"),
        })
        return
      }
      const data = result.data as StorageCompactResult | undefined
      refresh()
      const reclaimed = compactReclaimed(data)
      showToast({
        variant: "success",
        title: language.t("settings.database.compact.toast.success.title"),
        description:
          reclaimed > 0
            ? language.t("settings.database.compact.toast.success.description", {
                size: formatBytes(reclaimed),
                before: formatBytes(databaseFootprint(data?.before?.database)),
                after: formatBytes(databaseFootprint(data?.after?.database)),
              })
            : language.t("settings.database.compact.toast.success.none"),
      })
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("settings.database.compact.toast.failed.title"),
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBusy(false)
    }
  }

  const openConfirm = () => {
    if (!selected() || busy()) return
    // push 叠在设置弹窗上；show 会清空整个 dialog 栈导致设置消失
    void dialog.push(() => (
      <Dialog title={language.t("settings.database.compact.confirm.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex flex-col gap-2">
            <span class="text-14-regular text-text-strong">
              {language.t("settings.database.compact.confirm.body")}
            </span>
            <span class="text-12-regular text-text-weak">
              {language.t("settings.database.compact.confirm.estimate", {
                size: formatBytes(estimateBytes()),
              })}
            </span>
            <ul class="text-12-regular text-text-weak list-disc pl-4 flex flex-col gap-1">
              <Show when={actions().checkpoint}>
                <li>{language.t("settings.database.compact.action.checkpoint")}</li>
              </Show>
              <Show when={actions().vacuum}>
                <li>{language.t("settings.database.compact.action.vacuum")}</li>
              </Show>
              <Show when={actions().toolOutput}>
                <li>
                  {language.t("settings.database.compact.action.toolOutput.detail", {
                    count: formatCount(budget.latest?.toolOutput?.expiredFiles),
                    size: formatBytes(budget.latest?.toolOutput?.expiredBytes),
                    days: String(budget.latest?.retentionDays ?? 7),
                  })}
                </li>
              </Show>
              <Show when={actions().logs}>
                <li>
                  {language.t("settings.database.compact.action.logs.detail", {
                    count: formatCount(budget.latest?.logs?.expiredFiles),
                    size: formatBytes(budget.latest?.logs?.expiredBytes),
                    days: String(budget.latest?.retentionDays ?? 7),
                  })}
                </li>
              </Show>
            </ul>
            <span class="text-12-regular text-text-weak">
              {language.t("settings.database.compact.confirm.safe")}
            </span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="large"
              onClick={() => {
                dialog.close()
                void runCompact()
              }}
            >
              {language.t("settings.database.compact.confirm.run")}
            </Button>
          </div>
        </div>
      </Dialog>
    ))
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
            <Button size="small" variant="ghost" onClick={() => copy(props.value!, props.copyKey)}>
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

  const ActionRow: Component<{
    title: string
    description: string
    checked: boolean
    onChange: () => void
  }> = (props) => {
    return (
      <div class="flex flex-wrap items-center gap-4 py-3 border-b border-border-weak-base last:border-none sm:flex-nowrap">
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="text-14-medium text-text-strong">{props.title}</span>
          <span class="text-12-regular text-text-weak">{props.description}</span>
        </div>
        <div class="flex w-full justify-end sm:w-auto sm:shrink-0">
          <Switch checked={props.checked} onChange={props.onChange} />
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
              <Button size="small" variant="ghost" onClick={refresh} disabled={busy()}>
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
                    {language.t("settings.database.section.breakdown")}
                  </h3>
                  <p class="text-12-regular text-text-weak pb-2">
                    {language.t("settings.database.breakdown.description")}
                  </p>
                  <SettingsList>
                    <StatRow
                      title={language.t("settings.database.breakdown.total")}
                      value={formatBytes(budget.latest?.dataBytes)}
                    />
                    <StatRow
                      title={language.t("settings.database.breakdown.activeDb")}
                      value={formatBytes(totalSize())}
                    />
                    <For
                      each={budget.latest?.entries ?? []}
                      fallback={
                        <div class="py-3 text-12-regular text-text-weak">
                          {budget.loading
                            ? language.t("settings.database.loading")
                            : language.t("settings.database.breakdown.empty")}
                        </div>
                      }
                    >
                      {(entry) => (
                        <div class="flex flex-wrap items-start gap-3 py-3 border-b border-border-weak-base last:border-none sm:flex-nowrap">
                          <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span class="text-14-medium text-text-strong font-mono">{entry.name}</span>
                            <span class="text-12-regular text-text-weak">
                              {entry.kind === "directory"
                                ? language.t("settings.database.breakdown.kind.directory")
                                : language.t("settings.database.breakdown.kind.file")}
                            </span>
                          </div>
                          <div class="flex w-full items-center justify-end gap-2 sm:w-auto sm:shrink-0">
                            <span class="text-12-regular text-text-weak font-mono">
                              {formatBytes(entry.bytes)}
                            </span>
                            <Show when={platform.revealPath}>
                              <Button size="small" variant="ghost" onClick={() => reveal(entry.path)}>
                                {language.t("settings.database.action.reveal")}
                              </Button>
                            </Show>
                          </div>
                        </div>
                      )}
                    </For>
                  </SettingsList>
                </div>

                <div class="flex flex-col gap-1">
                  <h3 class="text-14-medium text-text-strong pb-2">
                    {language.t("settings.database.section.tableRows")}
                  </h3>
                  <p class="text-12-regular text-text-weak pb-2">
                    {language.t("settings.database.tableRows.description")}
                  </p>
                  <SettingsList>
                    <For
                      each={budget.latest?.tables ?? info().tables}
                      fallback={
                        <div class="py-3 text-12-regular text-text-weak">
                          {language.t("settings.database.tables.empty")}
                        </div>
                      }
                    >
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

                <div class="flex flex-col gap-1">
                  <h3 class="text-14-medium text-text-strong pb-2">
                    {language.t("settings.database.section.compact")}
                  </h3>
                  <p class="text-12-regular text-text-weak pb-2">
                    {language.t("settings.database.compact.description")}
                  </p>
                  <SettingsList>
                    <StatRow
                      title={language.t("settings.database.compact.row.reclaimable.title")}
                      value={formatBytes(budget.latest?.database?.reclaimableBytes)}
                    />
                    <StatRow
                      title={language.t("settings.database.compact.row.toolOutput.title")}
                      value={language.t("settings.database.compact.row.files.value", {
                        size: formatBytes(budget.latest?.toolOutput?.expiredBytes),
                        count: formatCount(budget.latest?.toolOutput?.expiredFiles),
                      })}
                    />
                    <StatRow
                      title={language.t("settings.database.compact.row.logs.title")}
                      value={language.t("settings.database.compact.row.files.value", {
                        size: formatBytes(budget.latest?.logs?.expiredBytes),
                        count: formatCount(budget.latest?.logs?.expiredFiles),
                      })}
                    />
                    <StatRow
                      title={language.t("settings.database.compact.row.estimate.title")}
                      value={formatBytes(estimateBytes())}
                    />
                    <ActionRow
                      title={language.t("settings.database.compact.action.checkpoint")}
                      description={language.t("settings.database.compact.action.checkpoint.description")}
                      checked={actions().checkpoint}
                      onChange={() => toggle("checkpoint")}
                    />
                    <ActionRow
                      title={language.t("settings.database.compact.action.vacuum")}
                      description={language.t("settings.database.compact.action.vacuum.description")}
                      checked={actions().vacuum}
                      onChange={() => toggle("vacuum")}
                    />
                    <ActionRow
                      title={language.t("settings.database.compact.action.toolOutput")}
                      description={language.t("settings.database.compact.action.toolOutput.description", {
                        days: String(budget.latest?.retentionDays ?? 7),
                      })}
                      checked={actions().toolOutput}
                      onChange={() => toggle("toolOutput")}
                    />
                    <ActionRow
                      title={language.t("settings.database.compact.action.logs")}
                      description={language.t("settings.database.compact.action.logs.description", {
                        days: String(budget.latest?.retentionDays ?? 7),
                      })}
                      checked={actions().logs}
                      onChange={() => toggle("logs")}
                    />
                  </SettingsList>
                  <div class="flex justify-end pt-3">
                    <Button
                      size="small"
                      variant="secondary"
                      disabled={!selected() || busy() || budget.loading}
                      onClick={openConfirm}
                    >
                      {busy()
                        ? language.t("settings.database.compact.running")
                        : language.t("settings.database.compact.review")}
                    </Button>
                  </div>
                </div>

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
              </>
            )}
          </Show>
        </Show>
      </div>
    </div>
  )
}
