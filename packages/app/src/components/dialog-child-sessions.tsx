import type { Session } from "@opencode-ai/sdk/v2/client"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { List } from "@opencode-ai/ui/list"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createMemo, createResource, createSignal, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useSessionKey } from "@/pages/session/session-layout"
import { directChildSessions } from "@/pages/layout/helpers"
import { agentColor } from "@/utils/agent"
import { legacySessionHref, requireServerKey, sessionHref } from "@/utils/session-route"
import { sessionTitle } from "@/utils/session-title"
import type { Part as PartType } from "@opencode-ai/sdk/v2"

const taskMetaFromPart = (
  part: PartType,
  out: Map<string, { description?: string; agent?: string }>,
) => {
  if (part.type !== "tool") return
  if (part.tool !== "task" && part.tool !== "task_followup") return
  const metadata = "metadata" in part.state ? part.state.metadata : undefined
  if (!metadata || typeof metadata !== "object") return

  const input = part.state.input
  const fromInput = input && typeof input === "object" ? (input as Record<string, unknown>) : undefined
  const description =
    (typeof fromInput?.description === "string" && fromInput.description) ||
    (typeof metadata.description === "string" && metadata.description) ||
    (typeof metadata.title === "string" && metadata.title) ||
    undefined
  const agent =
    (typeof fromInput?.subagent_type === "string" && fromInput.subagent_type) ||
    (typeof fromInput?.agent === "string" && fromInput.agent) ||
    (typeof metadata.agent === "string" && metadata.agent) ||
    undefined

  const write = (id: string, next: { description?: string; agent?: string }) => {
    const prev = out.get(id) ?? {}
    out.set(id, {
      description: prev.description ?? next.description,
      agent: prev.agent ?? next.agent,
    })
  }

  if (typeof metadata.sessionId === "string") {
    write(metadata.sessionId, { description, agent })
  }

  const tasks = Array.isArray(metadata.tasks) ? metadata.tasks : undefined
  if (!tasks) return
  for (const item of tasks) {
    if (!item || typeof item !== "object") continue
    const row = item as Record<string, unknown>
    const id =
      (typeof row.sessionId === "string" && row.sessionId) ||
      (typeof row.sessionID === "string" && row.sessionID) ||
      undefined
    if (!id) continue
    write(id, {
      description:
        (typeof row.description === "string" && row.description) ||
        (typeof row.title === "string" && row.title) ||
        undefined,
      agent:
        (typeof row.subagent_type === "string" && row.subagent_type) ||
        (typeof row.agent === "string" && row.agent) ||
        undefined,
    })
  }
}

const cleanTitle = (title?: string) => {
  const value = sessionTitle(title)
  if (!value) return
  return value.replace(/\s+\(@[^)]+ subagent\)$/, "")
}

const agentFromTitle = (title?: string) => title?.match(/@(\w+) subagent/)?.[1]

/** Fetch direct children from the server and merge into the local session store. */
export async function loadChildSessions(input: {
  parentID: string
  client: { session: { children: (args: { sessionID: string; directory?: string }) => Promise<{ data?: Session[] }> } }
  directory: string
  remember: (session: Session) => void
}) {
  const result = await input.client.session.children({
    sessionID: input.parentID,
    directory: input.directory,
  })
  const children = (result.data ?? []).filter((session) => !!session?.id && !session.time?.archived)
  for (const session of children) {
    input.remember(session)
  }
  return children.sort(
    (a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created),
  )
}

export function DialogChildSessions(props: { parentID: string }) {
  const language = useLanguage()
  const dialog = useDialog()
  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const { params } = useSessionKey()
  const [fetched, setFetched] = createSignal<Session[]>()

  const [remote] = createResource(
    () => props.parentID,
    async (parentID) => {
      const children = await loadChildSessions({
        parentID,
        client: sdk().client,
        directory: sdk().directory,
        remember: (session) => sync().session.remember(session),
      })
      setFetched(children)
      return children
    },
  )

  const children = createMemo(() => {
    const fromApi = fetched() ?? remote()
    if (fromApi) return fromApi
    return directChildSessions(sync().data.session, props.parentID)
  })

  const meta = createMemo(() => {
    const map = new Map<string, { description?: string; agent?: string }>()
    const messages = sync().data.message[props.parentID] ?? []
    for (const message of messages) {
      for (const part of sync().data.part[message.id] ?? []) {
        taskMetaFromPart(part, map)
      }
    }
    return map
  })

  const agents = createMemo(() => sync().data.agent ?? [])

  const items = createMemo(() =>
    children().map((session) => {
      const info = meta().get(session.id)
      const agentKey = info?.agent ?? agentFromTitle(session.title)
      const agent = agents().find((item) => item.name === agentKey || item.name.toLowerCase() === agentKey?.toLowerCase())
      const agentName = agent?.name ?? (agentKey ? `${agentKey[0]!.toUpperCase()}${agentKey.slice(1)}` : undefined)
      const color = agentName ? agentColor(agentName, agent?.color) : undefined
      const description =
        info?.description ?? cleanTitle(session.title) ?? language.t("command.session.new")
      const working = (sync().data.session_status[session.id]?.type ?? "idle") !== "idle"
      return {
        session,
        agent: agentName,
        color,
        description,
        // List filter uses these string fields
        title: [agentName, description].filter(Boolean).join(" "),
        working,
      }
    }),
  )

  const openSession = (session: Session) => {
    navigate(
      params.serverKey
        ? sessionHref(requireServerKey(params.serverKey), session.id)
        : legacySessionHref(sdk().directory, session.id),
    )
    dialog.close()
  }

  return (
    <Dialog
      title={language.t("dialog.childSessions.title")}
      description={language.t("dialog.childSessions.description", { count: String(children().length) })}
    >
      <Show
        when={!remote.loading || children().length > 0}
        fallback={
          <div class="flex items-center justify-center py-10">
            <Spinner class="size-4" />
          </div>
        }
      >
        <List
          class="px-3"
          search={{
            placeholder: language.t("common.search.placeholder"),
            autofocus: true,
          }}
          emptyMessage={language.t("dialog.childSessions.empty")}
          key={(x) => x?.session.id ?? ""}
          items={items}
          filterKeys={["title", "description", "agent"]}
          activeIcon="square-arrow-top-right"
          onSelect={(item) => {
            if (!item) return
            openSession(item.session)
          }}
        >
          {(item) => (
            <div class="w-full flex items-center justify-start gap-2 min-w-0 text-left">
              <Show
                when={!item.working}
                fallback={
                  <span
                    class="inline-flex size-4 shrink-0 items-center justify-center"
                    style={{ color: item.color ?? "var(--icon-interactive-base)" }}
                  >
                    <Spinner class="size-3.5" />
                  </span>
                }
              >
                <span
                  class="inline-flex size-4 shrink-0 items-center justify-center"
                  style={{ color: item.color ?? "var(--icon-interactive-base)" }}
                >
                  <Icon name="subagent" size="small" />
                </span>
              </Show>
              <Show when={item.agent}>
                {(name) => (
                  <span
                    class="shrink-0 text-14-medium capitalize"
                    style={{ color: item.color ?? "var(--text-strong)" }}
                  >
                    {name()}
                  </span>
                )}
              </Show>
              <span class="min-w-0 truncate text-14-regular text-text-strong">{item.description}</span>
            </div>
          )}
        </List>
      </Show>
    </Dialog>
  )
}
