import type { GlobalSession } from "@opencode-ai/sdk/v2/client"
import { getFilename } from "@opencode-ai/core/util/path"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createMemo, createResource, createSignal, Show } from "solid-js"
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
  const [busyID, setBusyID] = createSignal<string>()

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
    if (busyID()) return
    setBusyID(session.id)
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
      setBusyID(undefined)
    }
  }

  const description = createMemo(() => {
    if (props.project) return displayName(props.project)
    if (props.directory) return getFilename(props.directory)
    return language.t("dialog.archivedSessions.description")
  })

  return (
    <Dialog title={language.t("dialog.archivedSessions.title")} description={description()}>
      <List
        class="px-3"
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
          openSession(session)
        }}
      >
        {(session) => (
          <div class="w-full flex items-center justify-between gap-x-3 min-w-0">
            <div class="flex flex-col gap-0.5 min-w-0">
              <span class="truncate text-14-medium text-text-strong">
                {session.title || language.t("command.session.new")}
              </span>
              <span class="truncate text-12-regular text-text-weak">
                {getFilename(session.directory)}
                <Show when={session.time.archived}>{(at) => ` · ${new Date(at()).toLocaleString()}`}</Show>
              </span>
            </div>
            <div class="shrink-0 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
              <Button
                variant="ghost"
                size="small"
                disabled={busyID() === session.id}
                onClick={() => void unarchive(session)}
              >
                {language.t("dialog.archivedSessions.unarchive")}
              </Button>
              <Button variant="ghost" size="small" onClick={() => openSession(session)}>
                {language.t("common.open")}
              </Button>
            </div>
          </div>
        )}
      </List>
    </Dialog>
  )
}
