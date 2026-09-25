import type { GlobalSession } from "@opencode-ai/sdk/v2/client"
import { getFilename } from "@opencode-ai/core/util/path"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createMemo, createResource, createSignal, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useServer } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { useLayout, type LocalProject } from "@/context/layout"
import { displayName } from "@/pages/layout/helpers"
import { showToast } from "@/utils/toast"

export function DialogArchivedSessions(props: { directory?: string; project?: LocalProject }) {
  const language = useLanguage()
  const dialog = useDialog()
  const serverSDK = useServerSDK()
  const server = useServer()
  const tabs = useTabs()
  const layout = useLayout()
  const [query, setQuery] = createSignal("")
  const [state, setState] = createStore({
    busyID: undefined as string | undefined,
    // 管理模式：显示每行复选框并在底部提供批量操作工具栏。
    managing: false,
    selected: {} as Record<string, boolean>,
    deleting: false,
  })

  const [sessions, { refetch }] = createResource(
    () => ({ directory: props.directory, q: query() }),
    async (input) => {
      const result = await serverSDK().client.experimental.session.list({
        roots: true,
        archived: true,
        directory: input.directory,
        search: input.q.trim() || undefined,
        limit: 100,
      })
      return (result.data ?? [])
        .filter((session) => typeof session.time.archived === "number")
        .sort((a, b) => (b.time.archived ?? 0) - (a.time.archived ?? 0))
    },
  )

  const items = createMemo(() => sessions() ?? [])

  const selectedIDs = createMemo(() => items().filter((s) => state.selected[s.id]).map((s) => s.id))
  const selectedCount = createMemo(() => selectedIDs().length)
  const allSelected = createMemo(() => items().length > 0 && items().every((s) => state.selected[s.id]))

  const openSession = (session: GlobalSession) => {
    if (session.directory) layout.projects.open(session.directory)
    const tab = tabs.addSessionTab({
      server: server.key,
      sessionId: session.id,
    })
    tabs.select(tab)
    dialog.close()
  }

  const unarchive = async (session: GlobalSession) => {
    if (state.busyID) return
    setState("busyID", session.id)
    try {
      // null clears time.archived on the server (unarchive).
      await serverSDK().client.session.update({
        sessionID: session.id,
        directory: session.directory,
        time: { archived: null as unknown as number },
      })
      await refetch()
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setState("busyID", undefined)
    }
  }

  const toggleSelected = (session: GlobalSession, checked: boolean) => {
    setState("selected", session.id, checked)
  }

  const toggleAll = (checked: boolean) => {
    const next: Record<string, boolean> = {}
    if (checked) {
      for (const session of items()) next[session.id] = true
    }
    setState("selected", next)
  }

  const exitManage = () => {
    setState("managing", false)
    setState("selected", {})
  }

  const deleteOne = async (session: GlobalSession) => {
    if (state.busyID || state.deleting) return
    setState("busyID", session.id)
    try {
      await serverSDK().client.session.delete({
        sessionID: session.id,
        directory: session.directory,
      })
      setState("selected", session.id, undefined as unknown as boolean)
      await refetch()
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("session.delete.failed.title"),
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setState("busyID", undefined)
    }
  }

  const deleteSelected = async () => {
    const ids = selectedIDs()
    if (!ids.length || state.deleting) return
    setState("deleting", true)
    try {
      // 逐个删除并在最后一次性刷新，避免中途频繁拉取。
      const failed: string[] = []
      for (const id of ids) {
        const session = items().find((s) => s.id === id)
        if (!session) continue
        try {
          await serverSDK().client.session.delete({
            sessionID: session.id,
            directory: session.directory,
          })
        } catch {
          failed.push(id)
        }
      }
      setState("selected", {})
      await refetch()
      if (failed.length) {
        showToast({
          variant: "error",
          title: language.t("session.delete.failed.title"),
          description: language.t("dialog.archivedSessions.deleteFailed", { count: failed.length }),
        })
      }
    } finally {
      setState("deleting", false)
    }
  }

  const confirmDeleteSelected = () => {
    const count = selectedCount()
    if (!count) return
    dialog.push(() => (
      <Dialog title={language.t("session.delete.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex flex-col gap-1">
            <span class="text-14-regular text-text-strong">
              {language.t("dialog.archivedSessions.deleteConfirm", { count })}
            </span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" size="large" onClick={() => {
              dialog.close()
              void deleteSelected()
            }}>
              {language.t("session.delete.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    ))
  }

  const description = createMemo(() => {
    if (props.project) return displayName(props.project)
    if (props.directory) return getFilename(props.directory)
    return language.t("dialog.archivedSessions.description")
  })

  return (
    <Dialog
      title={language.t("dialog.archivedSessions.title")}
      description={description()}
      action={
        <div class="flex items-center gap-1">
          <Show when={!state.managing}>
            <Button
              variant="ghost"
              size="small"
              onClick={() => setState("managing", true)}
            >
              {language.t("dialog.archivedSessions.manage")}
            </Button>
          </Show>
          <IconButton
            icon="close"
            variant="ghost"
            aria-label={language.t("common.close")}
            onClick={() => dialog.close()}
          />
        </div>
      }
    >
      <div class="flex flex-col min-h-0" style={{ height: "100%" }}>
        <List
          class="px-3 flex-1 min-h-0"
          search={{
            placeholder: language.t("common.search.placeholder"),
            autofocus: true,
          }}
          onFilter={(value) => setQuery(value)}
          emptyMessage={language.t("dialog.archivedSessions.empty")}
          key={(x) => x?.id ?? ""}
          items={items}
          filterKeys={["title", "directory"]}
          onSelect={(session) => {
            if (!session) return
            if (state.managing) {
              toggleSelected(session, !state.selected[session.id])
              return
            }
            openSession(session)
          }}
        >
          {(session) => (
            <div class="flex items-center justify-between gap-x-3 min-w-0" style={{ width: "100%" }}>
              <div class="flex items-center gap-3 min-w-0 flex-1">
                <Show when={state.managing}>
                  <span onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={!!state.selected[session.id]}
                      onChange={(checked) => toggleSelected(session, !!checked)}
                      hideLabel
                    >
                      {session.title}
                    </Checkbox>
                  </span>
                </Show>
                <div class="flex flex-col gap-0.5 min-w-0 text-left">
                  <span class="truncate text-14-medium text-text-strong">
                    {session.title || language.t("command.session.new")}
                  </span>
                  <span class="truncate text-12-regular text-text-weak">
                    {getFilename(session.directory)}
                    <Show when={session.time.archived}>{(at) => ` · ${new Date(at()).toLocaleString()}`}</Show>
                  </span>
                </div>
              </div>
              <Show when={!state.managing}>
                <div class="shrink-0 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                  <Button
                    variant="ghost"
                    size="small"
                    disabled={state.busyID === session.id || state.deleting}
                    onClick={() => void unarchive(session)}
                  >
                    {language.t("dialog.archivedSessions.unarchive")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="small"
                    disabled={state.busyID === session.id || state.deleting}
                    onClick={() => void deleteOne(session)}
                  >
                    {language.t("common.delete")}
                  </Button>
                  <Button variant="ghost" size="small" onClick={() => openSession(session)}>
                    {language.t("common.open")}
                  </Button>
                </div>
              </Show>
            </div>
          )}
        </List>
        <Show when={state.managing}>
          <div class="flex items-center justify-between gap-3 px-4 py-2 border-t border-border-weak-base">
            <div class="flex items-center gap-3">
              <Checkbox
                checked={allSelected()}
                onChange={(checked) => toggleAll(!!checked)}
                hideLabel
              >
                {language.t("dialog.archivedSessions.selectAll")}
              </Checkbox>
              <button
                type="button"
                class="text-13-regular text-text-base hover:text-text-strong"
                onClick={() => toggleAll(!allSelected())}
              >
                {language.t("dialog.archivedSessions.selectAll")}
              </button>
              <Show when={selectedCount() > 0}>
                <span class="text-12-regular text-text-weak">
                  {language.t("dialog.archivedSessions.selectedCount", { count: selectedCount() })}
                </span>
              </Show>
            </div>
            <div class="flex items-center gap-2">
              <Button
                variant="ghost"
                size="small"
                disabled={!selectedCount() || state.deleting}
                onClick={confirmDeleteSelected}
              >
                {language.t("common.delete")}
              </Button>
              <Button variant="primary" size="small" onClick={exitManage}>
                {language.t("dialog.archivedSessions.done")}
              </Button>
            </div>
          </div>
        </Show>
      </div>
    </Dialog>
  )
}
