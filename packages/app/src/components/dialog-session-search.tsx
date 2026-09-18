import { createMemo, createSignal, For, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { useLayout } from "@/context/layout"
import { sessionTitle } from "@/utils/session-title"
import { sortedRootSessions, displayName } from "@/pages/layout/helpers"
import { pinnedSessionIds } from "@/utils/session-pin"
import type { Session } from "@opencode-ai/sdk/v2/client"

export function DialogSessionSearch() {
  const language = useLanguage()
  const dialog = useDialog()
  const navigate = useNavigate()
  const serverSync = useServerSync()
  const layout = useLayout()
  const [query, setQuery] = createSignal("")

  const allSessions = createMemo(() => {
    const now = Date.now()
    const result: Array<{ session: Session; project: string }> = []
    for (const project of layout.projects.list()) {
      const [store] = serverSync().child(project.worktree, { bootstrap: false })
      const sessions = sortedRootSessions(store, now, pinnedSessionIds(project.worktree))
      for (const session of sessions) {
        result.push({ session, project: displayName(project) })
      }
    }
    return result.sort((a, b) => (b.session.time.updated ?? b.session.time.created) - (a.session.time.updated ?? a.session.time.created))
  })

  const items = createMemo(() => allSessions())

  const openSession = (session: Session) => {
    layout.projects.open(session.directory)
    navigate(`/${base64Encode(session.directory)}/session/${session.id}`)
    dialog.close()
  }

  return (
    <Dialog title={language.t("home.sessions.search.sessions")} class="w-full max-w-[480px]">
      <List
        class="px-3"
        search={{
          placeholder: language.t("home.sessions.search.placeholder"),
          autofocus: true,
        }}
        onFilter={(value) => setQuery(value)}
        emptyMessage={language.t("home.sessions.search.noResults", { query: query() })}
        key={(x) => x?.session.id ?? ""}
        items={items}
        filterKeys={["session.title"]}
        onSelect={(item) => {
          if (!item) return
          openSession(item.session)
        }}
      >
        {({ session, project }) => (
          <div class="flex min-w-0 items-center justify-between gap-3 py-2">
            <span class="min-w-0 flex-1 truncate text-14-medium text-text-strong">
              {sessionTitle(session.title)}
            </span>
            <span class="shrink-0 truncate text-12-regular text-text-weaker">{project}</span>
          </div>
        )}
      </List>
    </Dialog>
  )
}
