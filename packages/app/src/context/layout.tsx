import { createStore, produce, reconcile } from "solid-js/store"
import { batch, createEffect, createMemo, onCleanup, onMount, type Accessor } from "solid-js"
import { useLocation } from "@solidjs/router"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createMediaQuery } from "@solid-primitives/media"
import { useServerSync } from "./server-sync"
import { useServerSDK } from "./server-sdk"
import { RECENTLY_CLOSED_DISPLAY_LIMIT, ServerConnection, useServer } from "./server"
import { usePlatform } from "./platform"
import { Project } from "@opencode-ai/sdk/v2"
import { Persist, persisted, removePersisted } from "@/utils/persist"
import { pathKey } from "@/utils/path-key"
import { decode64 } from "@/utils/base64"
import { createScrollPersistence, type SessionScroll } from "./layout-scroll"
import type { ProjectAvatarVariant } from "@opencode-ai/ui/v2/project-avatar-v2"
import { migrateLegacySessionStateKeys, ServerScope, SessionStateKey } from "@/utils/server-scope"
import { createSessionKeyReader, ensureSessionKey, pruneSessionKeys } from "./layout-helpers"
import { requireServerKey } from "@/utils/session-route"
import { type DraftTab, useTabs } from "./tabs"

export { createSessionKeyReader, ensureSessionKey, pruneSessionKeys }

export type { ProjectAvatarVariant }

const AVATAR_COLOR_KEYS = ["pink", "mint", "orange", "purple", "cyan", "lime"] as const
const DEFAULT_SIDEBAR_WIDTH = 344
const DEFAULT_SESSION_WIDTH = 600
const DEFAULT_TERMINAL_HEIGHT = 280
const DEFAULT_REVIEW_PANEL_OPENED = false
export type AvatarColorKey = (typeof AVATAR_COLOR_KEYS)[number]

export function getAvatarColors(key?: string) {
  if (key && AVATAR_COLOR_KEYS.includes(key as AvatarColorKey)) {
    return {
      background: `var(--avatar-background-${key})`,
      foreground: `var(--avatar-text-${key})`,
    }
  }
  return {
    background: "var(--surface-info-base)",
    foreground: "var(--text-base)",
  }
}

export function getProjectAvatarVariant(key?: string): ProjectAvatarVariant {
  if (key === "mint") return "cyan"
  if (key === "lime") return "green"
  if (
    key === "orange" ||
    key === "yellow" ||
    key === "cyan" ||
    key === "green" ||
    key === "red" ||
    key === "pink" ||
    key === "blue" ||
    key === "purple" ||
    key === "gray"
  )
    return key
  return "gray"
}

type SessionView = {
  scroll: Record<string, SessionScroll>
  pendingMessage?: string
  pendingMessageAt?: number
  todoCollapsed?: boolean
}

export type LocalProject = Partial<Project> & { worktree: string; expanded: boolean }
export type HomeProjectSelection = { server: ServerConnection.Key; directory?: string }

export type ReviewPanelSource = "context-button" | "other"

export type LayoutRoute =
  | { type: "home" }
  | { type: "draft"; draftID: string; server?: ServerConnection.Key }
  | { type: "dir-new-sesssion"; dir: string; dirBase64: string; server?: ServerConnection.Key }
  | { type: "session"; sessionId: string; server?: ServerConnection.Key }

const currentRoute = (pathname: string, search: string): LayoutRoute => {
  const parts = pathname.split("/").filter(Boolean)
  if (parts.length === 0) return { type: "home" }

  if (parts[0] === "new-session") {
    const draftID = new URLSearchParams(search).get("draftId")
    if (!draftID) return { type: "home" }
    return { type: "draft", draftID }
  }

  if (parts[0] === "server" && parts[2] === "session" && parts[3]) {
    return {
      type: "session",
      sessionId: parts[3],
      server: requireServerKey(parts[1]),
    }
  }

  const dirBase64 = parts[0]
  const dir = decode64(dirBase64)
  if (!dir) return { type: "home" }

  if (parts[1] !== "session") return { type: "home" }

  const id = parts[2]
  if (id) return { type: "session", sessionId: id }
  return { type: "dir-new-sesssion", dir, dirBase64 }
}

export const { use: useLayout, provider: LayoutProvider } = createSimpleContext({
  name: "Layout",
  gate: false,
  init: () => {
    const serverSdk = useServerSDK()
    const serverSync = useServerSync()
    const server = useServer()
    const tabs = useTabs()
    const platform = usePlatform()
    const location = useLocation()
    const route = createMemo(() => {
      const value = currentRoute(location.pathname, location.search)
      if (value.type === "home") return value
      if (value.server) return value
      if (value.type === "draft") {
        const draft = tabs.store.find((tab): tab is DraftTab => tab.type === "draft" && tab.draftID === value.draftID)
        if (draft) return { ...value, server: draft.server }
      }
      return { ...value, server: server.key }
    })

    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value)

    const migrate = (value: unknown) => {
      if (!isRecord(value)) return value

      const sidebar = value.sidebar
      const migratedSidebar = (() => {
        if (!isRecord(sidebar)) return sidebar
        if (typeof sidebar.workspaces !== "boolean") return sidebar
        return {
          ...sidebar,
          workspaces: {},
          workspacesDefault: sidebar.workspaces,
        }
      })()

      const review = value.review
      const migratedReview = (() => {
        if (!isRecord(review)) return review
        if (typeof review.panelOpened === "boolean") return review

        return {
          ...review,
          panelOpened: DEFAULT_REVIEW_PANEL_OPENED,
        }
      })()

      const sessionView = migrateLegacySessionStateKeys(value.sessionView)

      if (migratedSidebar === sidebar && migratedReview === review && sessionView === value.sessionView) {
        return value
      }

      return {
        ...value,
        sidebar: migratedSidebar,
        review: migratedReview,
        sessionView,
      }
    }

    const target = Persist.serverGlobal(serverSdk().scope, "layout", ["layout.v6"])
    const [store, setStore, _, ready] = persisted(
      { ...target, migrate },
      createStore({
        sidebar: {
          opened: false,
          width: DEFAULT_SIDEBAR_WIDTH,
          workspaces: {} as Record<string, boolean>,
          workspacesDefault: false,
        },
        terminal: {
          height: DEFAULT_TERMINAL_HEIGHT,
          opened: false,
        },
        review: {
          panelOpened: DEFAULT_REVIEW_PANEL_OPENED,
        },
        session: {
          width: DEFAULT_SESSION_WIDTH,
        },
        mobileSidebar: {
          opened: false,
        },
        sessionView: {} as Record<string, SessionView>,
        home: {
          selection: { server: server.key } as HomeProjectSelection,
        },
      }),
    )
    const [ephemeral, setEphemeral] = createStore({
      reviewPanelSource: "other" as ReviewPanelSource,
    })

    const MAX_SESSION_KEYS = 50
    const PENDING_MESSAGE_TTL_MS = 2 * 60 * 1000
    const usage = {
      active: undefined as string | undefined,
      pruned: false,
      used: new Map<string, number>(),
    }

    const SESSION_STATE_KEYS = [
      { key: "prompt", legacy: "prompt", version: "v2" },
      { key: "terminal", legacy: "terminal", version: "v1" },
    ] as const

    const dropSessionState = (keys: string[]) => {
      for (const key of keys) {
        const scope = SessionStateKey.scope(key)
        const parts = SessionStateKey.route(key).split("/")
        const dir = parts[0]
        const session = parts[1]
        if (!dir) continue

        for (const entry of SESSION_STATE_KEYS) {
          const target = session
            ? Persist.serverSession(scope, dir, session, entry.key)
            : Persist.serverWorkspace(scope, dir, entry.key)
          void removePersisted(target, platform)

          if (scope !== ServerScope.local) continue
          const legacyKey = `${dir}/${entry.legacy}${session ? "/" + session : ""}.${entry.version}`
          void removePersisted({ key: legacyKey }, platform)
        }
      }
    }

    function prune(keep?: string) {
      const drop = pruneSessionKeys({
        keep,
        max: MAX_SESSION_KEYS,
        used: usage.used,
        view: Object.keys(store.sessionView),
      })
      if (drop.length === 0) return

      setStore(
        produce((draft) => {
          for (const key of drop) {
            delete draft.sessionView[key]
          }
        }),
      )

      scroll.drop(drop)
      dropSessionState(drop)

      for (const key of drop) {
        usage.used.delete(key)
      }
    }

    function touch(sessionKey: string) {
      usage.active = sessionKey
      usage.used.set(sessionKey, Date.now())

      if (!ready()) return
      if (usage.pruned) return

      usage.pruned = true
      prune(sessionKey)
    }

    const scroll = createScrollPersistence({
      debounceMs: 250,
      getSnapshot: (sessionKey) => store.sessionView[sessionKey]?.scroll,
      onFlush: (sessionKey, next) => {
        const current = store.sessionView[sessionKey]
        const keep = usage.active ?? sessionKey
        if (!current) {
          setStore("sessionView", sessionKey, { scroll: next })
          prune(keep)
          return
        }

        setStore("sessionView", sessionKey, "scroll", (prev) => ({ ...prev, ...next }))
        prune(keep)
      },
    })

    const ensureKey = (key: string) => ensureSessionKey(key, touch, (sessionKey) => scroll.seed(sessionKey))

    createEffect(() => {
      if (!ready()) return
      if (usage.pruned) return
      const active = usage.active
      if (!active) return
      usage.pruned = true
      prune(active)
    })

    onMount(() => {
      const flush = () => batch(() => scroll.flushAll())
      const handleVisibility = () => {
        if (document.visibilityState !== "hidden") return
        flush()
      }

      makeEventListener(window, "pagehide", flush)
      makeEventListener(document, "visibilitychange", handleVisibility)

      onCleanup(() => {
        scroll.dispose()
      })
    })

    const [colors, setColors] = createStore<Record<string, AvatarColorKey>>({})
    const colorRequested = new Map<string, AvatarColorKey>()

    function pickAvailableColor(used: Set<string>): AvatarColorKey {
      const available = AVATAR_COLOR_KEYS.filter((c) => !used.has(c))
      if (available.length === 0) return AVATAR_COLOR_KEYS[Math.floor(Math.random() * AVATAR_COLOR_KEYS.length)]
      return available[Math.floor(Math.random() * available.length)]
    }

    function enrich(project: { worktree: string; expanded: boolean }) {
      const [childStore] = serverSync().child(project.worktree, { bootstrap: false })
      const projectID = childStore.project
      const metadata = projectID
        ? serverSync().data.project.find((x) => x.id === projectID)
        : serverSync().data.project.find((x) => x.worktree === project.worktree)

      // Preserve local icon override from per-workspace localStorage cache (childStore.icon).
      // Without this, different subdirectories of the same git repo would share the same
      // icon from the database instead of using their individual overrides.
      const base = { ...metadata, ...project }
      if (childStore.icon) {
        return { ...base, icon: { ...base.icon, override: childStore.icon } }
      }
      return base
    }

    const roots = createMemo(() => {
      const map = new Map<string, string>()
      for (const project of serverSync().data.project) {
        const sandboxes = project.sandboxes ?? []
        for (const sandbox of sandboxes) {
          map.set(sandbox, project.worktree)
        }
      }
      return map
    })

    const rootFor = (directory: string) => {
      const map = roots()
      if (map.size === 0) return directory

      const visited = new Set<string>()
      const chain = [directory]

      while (chain.length) {
        const current = chain[chain.length - 1]
        if (!current) return directory

        const next = map.get(current)
        if (!next) return current

        if (visited.has(next)) return directory
        visited.add(next)
        chain.push(next)
      }

      return directory
    }

    createEffect(() => {
      const projects = server.projects.list()
      const seen = new Set(projects.map((project) => project.worktree))

      batch(() => {
        for (const project of projects) {
          const root = rootFor(project.worktree)
          if (root === project.worktree) continue

          server.projects.remove(project.worktree)

          if (!seen.has(root)) {
            server.projects.open(root)
            seen.add(root)
          }

          if (project.expanded) server.projects.expand(root)
        }
      })
    })

    const enriched = createMemo(() => server.projects.list().map(enrich))
    const list = createMemo(() => {
      const projects = enriched()
      return projects.map((project) => {
        const color = project.icon?.color ?? colors[project.worktree]
        if (!color) return project
        const icon = project.icon ? { ...project.icon, color } : { color }
        return { ...project, icon }
      })
    })

    createEffect(() => {
      const projects = enriched()
      if (projects.length === 0) return
      if (!serverSync().ready) return

      for (const project of projects) {
        if (!project.id) continue
        if (project.id === "global") continue
        serverSync().project.icon(project.worktree, project.icon?.override)
      }
    })

    createEffect(() => {
      const projects = enriched()
      if (projects.length === 0) return

      for (const project of projects) {
        if (project.icon?.color) colorRequested.delete(project.worktree)
      }

      const used = new Set<string>()
      for (const project of projects) {
        const color = project.icon?.color ?? colors[project.worktree]
        if (color) used.add(color)
      }

      for (const project of projects) {
        if (project.icon?.color || project.icon?.override || project.icon?.url) continue
        const worktree = project.worktree
        const existing = colors[worktree]
        const color = existing ?? pickAvailableColor(used)
        if (!existing) {
          used.add(color)
          setColors(worktree, color)
        }
        if (!project.id) continue

        const requested = colorRequested.get(worktree)
        if (requested === color) continue
        colorRequested.set(worktree, color)

        if (project.id === "global") {
          serverSync().project.meta(worktree, { icon: { color } })
          continue
        }

        void serverSdk()
          .client.project.update({ projectID: project.id, directory: worktree, icon: { color } })
          .catch(() => {
            if (colorRequested.get(worktree) === color) colorRequested.delete(worktree)
          })
      }
    })

    let sessionFrame: number | undefined
    let sessionTimer: number | undefined

    onMount(() => {
      sessionFrame = requestAnimationFrame(() => {
        sessionFrame = undefined
        sessionTimer = window.setTimeout(() => {
          sessionTimer = undefined
          void Promise.all(
            server.projects.list().map((project) => {
              return serverSync().project.loadSessions(project.worktree)
            }),
          )
        }, 0)
      })
    })

    onCleanup(() => {
      if (sessionFrame !== undefined) cancelAnimationFrame(sessionFrame)
      if (sessionTimer !== undefined) window.clearTimeout(sessionTimer)
    })

    // PC layout breakpoint.
    const isDesktop = createMediaQuery("(min-width: 768px)")

    return {
      route,
      ready,
      isDesktop,
      home: {
        selection: createMemo(() => store.home.selection),
        setSelection(selection: HomeProjectSelection) {
          setStore("home", "selection", reconcile(selection))
        },
      },
      projects: {
        list,
        recentlyClosed: createMemo(() => {
          const known = new Set(serverSync().data.project.map((project) => pathKey(project.worktree)))
          return server.projects
            .recentlyClosed()
            .filter((worktree) => known.has(pathKey(worktree)))
            .slice(0, RECENTLY_CLOSED_DISPLAY_LIMIT)
            .map((worktree) => enrich({ worktree, expanded: false }))
        }),
        open(directory: string) {
          const root = rootFor(directory)
          if (server.projects.list().find((x) => x.worktree === root)) return
          void serverSync().project.loadSessions(root)
          server.projects.open(root)
        },
        close(directory: string) {
          server.projects.close(directory)
        },
        expand(directory: string) {
          server.projects.expand(directory)
        },
        collapse(directory: string) {
          server.projects.collapse(directory)
        },
        move(directory: string, toIndex: number) {
          server.projects.move(directory, toIndex)
        },
      },
      sidebar: {
        opened: createMemo(() => store.sidebar.opened),
        open() {
          setStore("sidebar", "opened", true)
        },
        close() {
          setStore("sidebar", "opened", false)
        },
        toggle() {
          setStore("sidebar", "opened", (x) => !x)
        },
        width: createMemo(() => store.sidebar.width),
        resize(width: number) {
          setStore("sidebar", "width", width)
        },
        workspaces(directory: string) {
          return () => store.sidebar.workspaces[directory] ?? store.sidebar.workspacesDefault ?? false
        },
        setWorkspaces(directory: string, value: boolean) {
          setStore("sidebar", "workspaces", directory, value)
        },
        toggleWorkspaces(directory: string) {
          const current = store.sidebar.workspaces[directory] ?? store.sidebar.workspacesDefault ?? false
          setStore("sidebar", "workspaces", directory, !current)
        },
      },
      terminal: {
        height: createMemo(() => store.terminal.height),
        resize(height: number) {
          setStore("terminal", "height", height)
        },
      },
      session: {
        width: createMemo(() => store.session?.width ?? DEFAULT_SESSION_WIDTH),
        resize(width: number) {
          if (!store.session) {
            setStore("session", { width })
            return
          }
          setStore("session", "width", width)
        },
      },
      mobileSidebar: {
        opened: createMemo(() => store.mobileSidebar?.opened ?? false),
        show() {
          setStore("mobileSidebar", "opened", true)
        },
        hide() {
          setStore("mobileSidebar", "opened", false)
        },
        toggle() {
          setStore("mobileSidebar", "opened", (x) => !x)
        },
      },
      pendingMessage: {
        set(sessionKey: string, messageID: string) {
          const at = Date.now()
          touch(sessionKey)
          const current = store.sessionView[sessionKey]
          if (!current) {
            setStore("sessionView", sessionKey, {
              scroll: {},
              pendingMessage: messageID,
              pendingMessageAt: at,
            })
            prune(usage.active ?? sessionKey)
            return
          }

          setStore(
            "sessionView",
            sessionKey,
            produce((draft) => {
              draft.pendingMessage = messageID
              draft.pendingMessageAt = at
            }),
          )
        },
        consume(sessionKey: string) {
          const current = store.sessionView[sessionKey]
          const message = current?.pendingMessage
          const at = current?.pendingMessageAt
          if (!message || !at) return

          setStore(
            "sessionView",
            sessionKey,
            produce((draft) => {
              delete draft.pendingMessage
              delete draft.pendingMessageAt
            }),
          )

          if (Date.now() - at > PENDING_MESSAGE_TTL_MS) return
          return message
        },
      },
      view(sessionKey: string | Accessor<string>) {
        const key = createSessionKeyReader(sessionKey, ensureKey)
        const s = createMemo(() => store.sessionView[key()] ?? { scroll: {} })
        const terminalOpened = createMemo(() => store.terminal?.opened ?? false)
        const reviewPanelOpened = createMemo(() => store.review?.panelOpened ?? DEFAULT_REVIEW_PANEL_OPENED)
        const reviewPanelSource = createMemo(() => (reviewPanelOpened() ? ephemeral.reviewPanelSource : "other"))

        function setTerminalOpened(next: boolean) {
          const current = store.terminal
          if (!current) {
            setStore("terminal", { height: DEFAULT_TERMINAL_HEIGHT, opened: next })
            return
          }

          const value = current.opened ?? false
          if (value === next) return
          setStore("terminal", "opened", next)
        }

        function setReviewPanelOpened(next: boolean, source: ReviewPanelSource) {
          const nextSource = next ? source : "other"
          const current = store.review
          if (!current) {
            batch(() => {
              setStore("review", { panelOpened: next })
              setEphemeral("reviewPanelSource", nextSource)
            })
            return
          }

          const value = current.panelOpened ?? DEFAULT_REVIEW_PANEL_OPENED
          if (value === next) {
            if (ephemeral.reviewPanelSource !== nextSource) setEphemeral("reviewPanelSource", nextSource)
            return
          }
          batch(() => {
            setStore("review", "panelOpened", next)
            setEphemeral("reviewPanelSource", nextSource)
          })
        }

        return {
          scroll(tab: string) {
            return scroll.scroll(key(), tab)
          },
          setScroll(tab: string, pos: SessionScroll) {
            scroll.setScroll(key(), tab, pos)
          },
          todoCollapsed: {
            get: () => s().todoCollapsed ?? false,
            set(collapsed: boolean) {
              const session = key()
              const current = store.sessionView[session]
              if (!current) {
                setStore("sessionView", session, { scroll: {}, todoCollapsed: collapsed })
              } else {
                setStore("sessionView", session, "todoCollapsed", collapsed)
              }
            },
          },
          terminal: {
            opened: terminalOpened,
            open() {
              setTerminalOpened(true)
            },
            close() {
              setTerminalOpened(false)
            },
            toggle() {
              setTerminalOpened(!terminalOpened())
            },
          },
          reviewPanel: {
            opened: reviewPanelOpened,
            source: reviewPanelSource,
            open(source: ReviewPanelSource = "other") {
              setReviewPanelOpened(true, source)
            },
            close() {
              setReviewPanelOpened(false, "other")
            },
            toggle() {
              setReviewPanelOpened(!reviewPanelOpened(), "other")
            },
          },
        }
      },
    }
  },
})
