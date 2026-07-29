import type { FilePart, Message, UserMessage } from "@opencode-ai/sdk/v2"
import { getFilename } from "@opencode-ai/core/util/path"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useMutation } from "@tanstack/solid-query"
import {
  batch,
  ErrorBoundary,
  onCleanup,
  Show,
  Match,
  Switch,
  createMemo,
  createEffect,
  createComputed,
  createSignal,
  on,
  onMount,
  type ParentProps,
  untrack,
} from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"

import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useLocal } from "@/context/local"
import { createStore } from "solid-js/store"
import { isScrollKeyTarget, scrollKey, scrollKeyOwner } from "@opencode-ai/ui/scroll-view"
import { createAutoScroll } from "@opencode-ai/ui/hooks"
import { Button } from "@opencode-ai/ui/button"
import { showToast } from "@/utils/toast"
import { useLocation, useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { NewSessionView, SessionHeader } from "@/components/session"
import { CommentsProvider, useComments } from "@/context/comments"
import { DirectoryDataProvider } from "@/pages/directory-layout"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { ModelsProvider } from "@/context/models"
import { useNotification } from "@/context/notification"
import { PromptProvider, usePrompt } from "@/context/prompt"
import { usePlatform } from "@/context/platform"
import { SDKProvider, useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { ServerConnection } from "@/context/server"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { useTabs } from "@/context/tabs"
import { TerminalProvider, useTerminal } from "@/context/terminal"
import { PromptInput } from "@/components/prompt-input"
import { useSettingsCommand } from "@/components/settings-dialog"
import { setCursorPosition } from "@/components/prompt-input/editor-dom"
import { promptLength } from "@/components/prompt-input/history"
import { type FollowupDraft, sendFollowupDraft } from "@/components/prompt-input/submit"
import {
  createPromptInputController,
  createSessionComposerController,
  createSessionComposerRegionController,
  SessionComposerRegion,
} from "@/pages/session/composer"
import { createSizing } from "@/pages/session/helpers"
import { MessageTimeline } from "@/pages/session/timeline/message-timeline"
import { createTimelineModel } from "@/pages/session/timeline/model"
import { collectSessionFindMatches } from "@/pages/session/session-find"
import { SessionFindBar } from "@/pages/session/session-find-bar"
import { clearSessionFindHighlights, scheduleSessionFindHighlights } from "@/pages/session/session-find-highlight"
import { useSessionLayout } from "@/pages/session/session-layout"
import { restorePromptModel, syncPromptModel, syncSessionModel } from "@/pages/session/session-model-helpers"
import {
  clampSessionPanelWidth,
  SESSION_PANEL_WIDTH_MIN,
  sessionPanelWidthMax,
} from "@/pages/session/session-panel-width"
import { SessionSidePanel } from "@/pages/session/session-side-panel"
import { TerminalPanel } from "@/pages/session/terminal-panel"
import { useComposerCommands } from "@/pages/session/use-composer-commands"
import { useSessionCommands } from "@/pages/session/use-session-commands"
import { useSessionHashScroll } from "@/pages/session/use-session-hash-scroll"
import { Identifier } from "@/utils/id"
import { Persist, persisted } from "@/utils/persist"
import { extractPromptFromParts } from "@/utils/prompt"
import { formatServerError, isLocalSessionNotFoundError, isSessionNotFoundError } from "@/utils/server-errors"
import { legacySessionHref, requireServerKey, sessionHref } from "@/utils/session-route"
import { notifySessionNotFound } from "@/components/titlebar-session-events"
import { useUsageExceededDialogs } from "./session/usage-exceeded-dialogs"
import { createSessionOwnership } from "./session/session-ownership"
import { createSessionLineage } from "./session/session-lineage"

type FollowupItem = FollowupDraft & { id: string }
type FollowupEdit = Pick<FollowupItem, "id" | "prompt" | "context">
const emptyFollowups: FollowupItem[] = []

const sessionViewState = () => ({
  messageId: undefined as string | undefined,
})

function isCurrentSessionNotFoundError(error: unknown, sessionID: string | undefined) {
  if (!sessionID) return false
  return isSessionNotFoundError(error, sessionID) || isLocalSessionNotFoundError(error, sessionID)
}

async function runPromptRollbackMutation<T, R>(input: {
  capturePrompt: () => { current: () => T[]; set: (value: T[]) => void; reset: () => void }
  optimistic: (prompt: { set: (value: T[]) => void; reset: () => void }) => void
  request: () => Promise<R>
  complete: (result: R) => void
  rollback: () => void
  fail: (error: unknown) => void
}) {
  const prompt = input.capturePrompt()
  const previous = prompt.current().slice()
  batch(() => input.optimistic(prompt))
  await input
    .request()
    .then(input.complete)
    .catch((error) => {
      batch(() => {
        input.rollback()
        prompt.set(previous)
      })
      input.fail(error)
    })
}

export function SessionPage() {
  return (
    <SessionProviders>
      <Page />
    </SessionProviders>
  )
}

// Rendered under app.tsx's TargetSessionRoute, which owns the per-server keyed
// remount around the server-scoped providers. Nothing here may key on the
// session ID: session tabs on the same server share this route instance, and
// workspace-scoped state (terminal, directory providers) lives below.
export function TargetSessionRouteContent() {
  const params = useParams<{ serverKey: string; id: string }>()
  const serverSync = useServerSync()
  const directory = createMemo(() => serverSync().session.lineage.peek(params.id)?.session.directory)
  return (
    // Settings must keep the target-server SDK, sync, and models context and remain registered
    // when session content falls back to the route error boundary.
    <TargetServerScopedProviders directory={directory} sessionID={() => params.id}>
      <TargetSessionSettingsCommand />
      <SessionRouteErrorBoundary sessionID={params.id} serverKey={requireServerKey(params.serverKey)} padded>
        <ResolvedTargetSessionRoute />
      </SessionRouteErrorBoundary>
    </TargetServerScopedProviders>
  )
}

function TargetSessionSettingsCommand() {
  useSettingsCommand()
  return null
}

export function SessionRouteErrorBoundary(
  props: ParentProps<{ sessionID?: string; serverKey?: ServerConnection.Key; padded?: boolean }>,
) {
  // Must not call useLanguage/useServer/useTabs here: after HMR the boundary can re-render
  // against a stale createContext identity and throw before children mount. Fallback UI is
  // intentionally context-free English so it cannot cascade into another provider error.
  return (
    <ErrorBoundary
      fallback={(error, reset) => (
        <SessionErrorFallback error={error} sessionID={props.sessionID} serverKey={props.serverKey} onDismiss={reset} />
      )}
    >
      {props.children}
    </ErrorBoundary>
  )
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return "Something went wrong"
}

function LeaveMissingSession(props: { sessionID: string; serverKey?: ServerConnection.Key }) {
  onMount(() => {
    notifySessionNotFound({
      server: props.serverKey,
      sessionID: props.sessionID,
    })
  })
  return null
}

function SessionErrorFallback(props: {
  error: unknown
  sessionID?: string
  serverKey?: ServerConnection.Key
  onDismiss?: () => void
}) {
  // Missing sessions leave immediately: no full-pane blocker. Context-free
  // fallback notifies TabsProvider via event (HMR-safe; no useTabs here).
  if (isCurrentSessionNotFoundError(props.error, props.sessionID) && props.sessionID) {
    return <LeaveMissingSession sessionID={props.sessionID} serverKey={props.serverKey} />
  }
  return (
    <div class="flex-1 min-h-0 flex flex-col items-center justify-center gap-4 p-6 text-center">
      <div class="text-16-medium text-text-strong">Session error</div>
      <pre class="max-w-xl max-h-48 overflow-auto whitespace-pre-wrap break-words text-12-regular text-text-weak">
        {errorMessage(props.error)}
      </pre>
      <Show when={props.onDismiss}>
        {(dismiss) => (
          <Button size="large" onClick={() => dismiss()()}>
            Dismiss
          </Button>
        )}
      </Show>
    </div>
  )
}

function ResolvedTargetSessionRoute() {
  const params = useParams<{ serverKey: string; id: string }>()
  const tabs = useTabs()
  const sync = useServerSync()
  const serverKey = createMemo(() => requireServerKey(params.serverKey))
  const current = createSessionLineage(
    () => params.id,
    () => sync().session.lineage,
  )
  const directory = createMemo(() => current()?.session.directory)
  const targetDirectory = () => directory()!

  createEffect(() => {
    const session = current()
    if (!session) return
    tabs.addSessionTab({
      server: serverKey(),
      sessionId: session.root.id,
    })
  })

  return (
    // Non-keyed: closes only while the target's directory is unknown (uncached
    // lineage mid-resolution), which tears down the workspace subtree including
    // the terminal. Same-workspace tab switches keep it open because warm
    // targets resolve synchronously from the sync cache.
    <Show when={directory()}>
      <SDKProvider directory={targetDirectory}>
        <DirectoryDataProvider directory={targetDirectory} server={serverKey}>
          <TargetSessionPage />
        </DirectoryDataProvider>
      </SDKProvider>
    </Show>
  )
}

// Owns the workspace-identity remount. Must not include the session ID in the
// key: SessionPage handles session changes reactively, and remounting here
// destroys workspace-scoped state (terminal PTYs, file/prompt providers).
function TargetSessionPage() {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  return (
    <Show when={`${serverSDK().scope}\0${sdk().directory}`} keyed>
      <SessionPage />
    </Show>
  )
}

function TargetServerScopedProviders(
  props: ParentProps<{ directory?: () => string | undefined; sessionID?: () => string | undefined }>,
) {
  return (
    <>
      <MarkSessionNotificationsViewed sessionID={props.sessionID} />
      <ModelsProvider directory={props.directory}>{props.children}</ModelsProvider>
    </>
  )
}

function MarkSessionNotificationsViewed(props: { sessionID?: () => string | undefined }) {
  const notification = useNotification()
  createEffect(() => {
    const sessionID = props.sessionID?.()
    if (!notification.ready() || !sessionID) return
    if (notification.session.unseenCount(sessionID) === 0) return
    notification.session.markViewed(sessionID)
  })
  return null
}

function SessionProviders(props: ParentProps) {
  return (
    <TerminalProvider>
      <PromptProvider>
        <CommentsProvider>{props.children}</CommentsProvider>
      </PromptProvider>
    </TerminalProvider>
  )
}

function SessionRouteFrame(props: ParentProps<{ padded?: boolean }>) {
  return (
    <div class="relative size-full overflow-hidden flex flex-col" classList={{ "p-2": props.padded }}>
      {props.children}
    </div>
  )
}

function SessionPanelFrame(props: ParentProps) {
  return <div class="flex-1 min-h-0 flex flex-col bg-background-stronger">{props.children}</div>
}

export default function Page() {
  const serverSync = useServerSync()
  const layout = useLayout()
  const local = useLocal()
  const sync = useSync()
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const settings = useSettings()
  const platform = usePlatform()
  const prompt = usePrompt()
  const comments = useComments()
  const terminal = useTerminal()
  const [searchParams, setSearchParams] = useSearchParams<{ prompt?: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const { params, sessionKey, view } = useSessionLayout()
  const sessionOwnership = createSessionOwnership(sessionKey)

  createEffect(() => {
    if (!prompt.ready()) return
    untrack(() => {
      if (params.id) return
      const text = searchParams.prompt
      if (!text) return
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
      setSearchParams({ ...searchParams, prompt: undefined })
    })
  })

  const [ui, setUi] = createStore({
    pendingMessage: undefined as string | undefined,
    scrollGesture: 0,
    scroll: {
      overflow: false,
      bottom: true,
      jump: false,
    },
  })

  const composer = createSessionComposerController()
  const inputController = createPromptInputController({
    sessionKey,
    sessionID: () => params.id,
    queryOptions: serverSync().queryOptions,
  })

  const isDesktop = layout.isDesktop
  const size = createSizing()
  const desktopTabsOpen = createMemo(() => isDesktop() && view().reviewPanel.opened())
  const desktopSidePanelOpen = desktopTabsOpen
  const mobileContextOpen = createMemo(
    () => !isDesktop() && view().reviewPanel.opened() && tabs().active() === "context",
  )
  let panelRow: HTMLDivElement | undefined
  const [panelRowWidth, setPanelRowWidth] = createSignal<number>()
  createResizeObserver(
    () => panelRow,
    ({ width }) => setPanelRowWidth(width),
  )
  // The observer reports the content-box width, which already excludes the row
  // padding; only the flex gap between the panels remains to subtract.
  const sessionPanelAvailable = panelRowWidth
  const sessionPanelMax = createMemo(() => {
    const available = sessionPanelAvailable()
    if (available === undefined) return 1000
    return sessionPanelWidthMax({ available, split: false })
  })
  // 拖拽中的宽度只保存在本地，避免 pointermove 每帧写入持久化布局。
  const [sessionDragWidth, setSessionDragWidth] = createSignal<number>()
  // Clamp at render time so window or sidebar resizes squeeze the chat panel
  // instead of the side pane, without overwriting the persisted width.
  const sessionPanelResizedWidth = createMemo(() =>
    clampSessionPanelWidth({
      width: sessionDragWidth() ?? layout.session.width(),
      available: sessionPanelAvailable(),
      split: false,
    }),
  )
  const sessionPanelWidth = createMemo(() => {
    if (!desktopSidePanelOpen()) return "100%"
    return `${sessionPanelResizedWidth()}px`
  })
  // Chat layout reacts to the shared right rail, not its current content.
  const centered = createMemo(() => isDesktop() && !desktopSidePanelOpen())

  const info = createMemo(() => (params.id ? sync().session.get(params.id) : undefined))
  const isChildSession = createMemo(() => !!info()?.parentID)
  const revertMessageID = createMemo(() => info()?.revert?.messageID)
  const timeline = createTimelineModel({ sessionID: () => params.id, revertMessageID })
  const historyLoading = timeline.history.loading
  const historyMore = timeline.history.more
  const lastUserMessage = timeline.lastUserMessage
  const messages = timeline.messages
  const messagesReady = timeline.ready
  const userMessages = timeline.userMessages
  const visibleUserMessages = timeline.visibleUserMessages

  createEffect(
    on(
      () => lastUserMessage()?.id,
      () => {
        const msg = lastUserMessage()
        if (!msg) return
        syncSessionModel(local, msg)
      },
    ),
  )

  let restoredModelSession: string | undefined
  createEffect(() => {
    const id = params.id
    if (!id || !prompt.ready() || !local.session.ready()) return
    if (restoredModelSession !== id) {
      restoredModelSession = id
      if (restorePromptModel(local, prompt)) return
    }
    syncPromptModel(local, prompt)
  })

  createEffect(
    on(
      () => ({ dir: sdk().directory, id: params.id }),
      (next, prev) => {
        if (!prev) return
        if (next.dir === prev.dir && next.id === prev.id) return
        if (prev.id && !next.id) local.session.reset()
      },
      { defer: true },
    ),
  )

  const [store, setStore] = createStore({
    ...sessionViewState(),
    newSessionWorktree: "main",
    deferRender: false,
  })

  const [followup, setFollowup] = persisted(
    Persist.serverWorkspace(serverSDK().scope, sdk().directory, "followup", ["followup.v1"]),
    createStore<{
      items: Record<string, FollowupItem[] | undefined>
      failed: Record<string, string | undefined>
      paused: Record<string, boolean | undefined>
      edit: Record<string, FollowupEdit | undefined>
    }>({
      items: {},
      failed: {},
      paused: {},
      edit: {},
    }),
  )

  let deferFrame: number | undefined
  let deferTimer: number | undefined
  createComputed((prev) => {
    const key = sessionKey()
    if (key !== prev) {
      setStore("deferRender", true)
      if (deferFrame !== undefined) cancelAnimationFrame(deferFrame)
      if (deferTimer !== undefined) clearTimeout(deferTimer)
      deferFrame = requestAnimationFrame(() => {
        deferFrame = undefined
        deferTimer = window.setTimeout(() => {
          deferTimer = undefined
          setStore("deferRender", false)
        }, 0)
      })
    }
    return key
  })

  onCleanup(() => {
    if (deferFrame !== undefined) cancelAnimationFrame(deferFrame)
    if (deferTimer !== undefined) clearTimeout(deferTimer)
  })

  let todoFrame: number | undefined
  let todoTimer: number | undefined
  const newSessionWorktree = createMemo(() => {
    if (store.newSessionWorktree === "create") return "create"
    const project = sync().project
    if (project && sdk().directory !== project.worktree) return sdk().directory
    return "main"
  })

  const setActiveMessage = (message: UserMessage | undefined) => {
    messageMark = scrollMark
    setStore("messageId", message?.id)
  }

  const anchor = (id: string) => `message-${id}`

  const cursor = () => {
    const root = scroller
    if (!root) return store.messageId

    const box = root.getBoundingClientRect()
    const line = box.top + 100
    const list = [...root.querySelectorAll<HTMLElement>("[data-message-id]")]
      .map((el) => {
        const id = el.dataset.messageId
        if (!id) return

        const rect = el.getBoundingClientRect()
        return { id, top: rect.top, bottom: rect.bottom }
      })
      .filter((item): item is { id: string; top: number; bottom: number } => !!item)

    const shown = list.filter((item) => item.bottom > box.top && item.top < box.bottom)
    const hit = shown.find((item) => item.top <= line && item.bottom >= line)
    if (hit) return hit.id

    const near = [...shown].sort((a, b) => {
      const da = Math.abs(a.top - line)
      const db = Math.abs(b.top - line)
      if (da !== db) return da - db
      return a.top - b.top
    })[0]
    if (near) return near.id

    return list.filter((item) => item.top <= line).at(-1)?.id ?? list[0]?.id ?? store.messageId
  }

  function navigateMessageByOffset(offset: number) {
    const msgs = visibleUserMessages()
    if (msgs.length === 0) return

    const current = store.messageId && messageMark === scrollMark ? store.messageId : cursor()
    const base = current ? msgs.findIndex((m) => m.id === current) : msgs.length
    const currentIndex = base === -1 ? msgs.length : base
    const targetIndex = currentIndex + offset
    if (targetIndex < 0 || targetIndex > msgs.length) return

    if (targetIndex === msgs.length) {
      resumeScroll()
      return
    }

    autoScroll.pause()
    scrollToMessage(msgs[targetIndex], "auto")
  }

  let inputRef!: HTMLDivElement
  let promptDock: HTMLDivElement | undefined
  let dockHeight = 0
  let scroller: HTMLDivElement | undefined
  let content: HTMLDivElement | undefined
  let revealMessage = (_id: string, _messageID?: string, _partID?: string) => {}
  let scrollToEnd = () => {}
  let scrollMark = 0
  let messageMark = 0

  const [findOpen, setFindOpen] = createSignal(false)
  const [findQuery, setFindQuery] = createSignal("")
  const [findIndex, setFindIndex] = createSignal(0)
  const [findFocus, setFindFocus] = createSignal(0)

  const sessionMessages = createMemo(() => {
    const id = params.id
    if (!id) return [] as Message[]
    return sync().data.message[id] ?? []
  })

  const findMatches = createMemo(() => {
    if (!findOpen()) return []
    const query = findQuery()
    if (!query.trim()) return []
    return collectSessionFindMatches({
      messages: sessionMessages(),
      parts: (messageID) => sync().data.part[messageID],
      query,
    })
  })

  const closeFind = () => {
    setFindOpen(false)
    clearSessionFindHighlights()
  }

  const openFind = () => {
    if (!params.id) return
    // Second Ctrl+F collapses the bar.
    if (findOpen()) {
      closeFind()
      return
    }
    setFindOpen(true)
    setFindFocus((n) => n + 1)
  }

  createEffect(
    on(
      () => params.id,
      () => {
        setFindOpen(false)
        setFindQuery("")
        setFindIndex(0)
        clearSessionFindHighlights()
      },
    ),
  )

  const scrollGestureWindowMs = 250

  const markScrollGesture = (target?: EventTarget | null) => {
    const root = scroller
    if (!root) return

    const el = target instanceof Element ? target : undefined
    const nested = el?.closest("[data-scrollable]")
    if (nested && nested !== root) return

    setUi("scrollGesture", Date.now())
  }

  const hasScrollGesture = () => Date.now() - ui.scrollGesture < scrollGestureWindowMs

  createEffect(
    on(
      () => {
        const id = params.id
        return [
          sdk().directory,
          id,
          id ? (sync().data.session_status[id]?.type ?? "idle") : "idle",
          id ? composer.blocked() : false,
        ] as const
      },
      ([dir, id, status, blocked]) => {
        if (todoFrame !== undefined) cancelAnimationFrame(todoFrame)
        if (todoTimer !== undefined) window.clearTimeout(todoTimer)
        todoFrame = undefined
        todoTimer = undefined
        if (!id) return
        if (status === "idle" && !blocked) return
        const cached = untrack(() => sync().data.todo[id] !== undefined)

        todoFrame = requestAnimationFrame(() => {
          todoFrame = undefined
          todoTimer = window.setTimeout(() => {
            todoTimer = undefined
            if (sdk().directory !== dir || params.id !== id) return
            untrack(() => {
              void sync().session.todo(id, cached ? { force: true } : undefined)
            })
          }, 0)
        })
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => visibleUserMessages().at(-1)?.id,
      (lastId, prevLastId) => {
        if (lastId && prevLastId && lastId > prevLastId) {
          setStore("messageId", undefined)
        }
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      sessionKey,
      () => {
        setStore(sessionViewState())
        setUi("pendingMessage", undefined)
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => sdk().directory,
      (dir) => {
        if (!dir) return
        setStore("newSessionWorktree", "main")
      },
      { defer: true },
    ),
  )

  const isEditableTarget = (target: EventTarget | null | undefined) => {
    if (!(target instanceof HTMLElement)) return false
    return /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName) || target.isContentEditable
  }

  const deepActiveElement = () => {
    let current: Element | null = document.activeElement
    while (current instanceof HTMLElement && current.shadowRoot?.activeElement) {
      current = current.shadowRoot.activeElement
    }
    return current instanceof HTMLElement ? current : undefined
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    const path = event.composedPath()
    const target = path.find((item): item is HTMLElement => item instanceof HTMLElement)
    const activeElement = deepActiveElement()

    const protectedTarget = path.some(
      (item) => item instanceof HTMLElement && item.closest("[data-prevent-autofocus]") !== null,
    )
    if (protectedTarget || isEditableTarget(target)) return

    if (activeElement) {
      const isProtected = activeElement.closest("[data-prevent-autofocus]")
      const isInput = isEditableTarget(activeElement)
      if (isProtected || isInput) return
    }
    if (dialog.active) return

    if (activeElement === inputRef) {
      if (event.key === "Escape") inputRef?.blur()
      return
    }

    const key = scrollKey(event)
    if (key) {
      if (!scroller || !isScrollKeyTarget(target ?? null, key)) return
      if (scrollKeyOwner(scroller, target ?? null, key) !== scroller) return
      markScrollGesture(scroller)
      return
    }

    if (event.key.length === 1 && event.key !== "Unidentified" && !(event.ctrlKey || event.metaKey)) {
      if (composer.blocked() || isChildSession()) return
      const input = inputRef
      if (!input) return
      input.focus()
      setCursorPosition(input, prompt.cursor() ?? promptLength(prompt.current()))
    }
  }

  const focusInput = () => {
    if (isChildSession()) return
    inputRef?.focus()
  }

  useComposerCommands()
  useSessionCommands({
    navigateMessageByOffset,
    setActiveMessage,
    focusInput,
    openFind,
  })
  const autoScroll = createAutoScroll({
    working: () => true,
    overflowAnchor: "none",
  })
  createEffect(
    on(
      () => params.id,
      (id, previous) => {
        if (!id || !previous || id === previous) return
        if (location.hash || store.messageId || ui.pendingMessage) return
        autoScroll.resume()
      },
    ),
  )

  const jumpFind = (index: number) => {
    const matches = findMatches()
    if (matches.length === 0) {
      setFindIndex(0)
      return
    }
    const next = ((index % matches.length) + matches.length) % matches.length
    setFindIndex(next)
    const match = matches[next]
    if (!match) return
    autoScroll.pause()
    revealMessage(match.userMessageID, match.messageID, match.partID)
  }

  const findNext = () => {
    if (findMatches().length === 0) return
    jumpFind(findIndex() + 1)
  }

  const findPrev = () => {
    if (findMatches().length === 0) return
    jumpFind(findIndex() - 1)
  }

  createEffect(
    on(findQuery, () => {
      if (!findOpen()) return
      setFindIndex(0)
      if (findMatches().length === 0) return
      jumpFind(0)
    }),
  )

  createEffect(
    on(findMatches, (matches) => {
      if (!findOpen()) return
      if (matches.length === 0) {
        setFindIndex(0)
        return
      }
      if (findIndex() >= matches.length) setFindIndex(0)
    }),
  )

  createEffect(
    on(
      () => [findOpen(), findQuery(), findIndex(), findMatches()] as const,
      ([open, query, index, matches]) => {
        if (!open) {
          clearSessionFindHighlights()
          return
        }
        const stop = scheduleSessionFindHighlights({
          host: scroller,
          query,
          matches,
          activeIndex: index,
        })
        onCleanup(stop)
      },
    ),
  )

  let scrollStateFrame: number | undefined
  let scrollStateTarget: HTMLDivElement | undefined
  let fillFrame: number | undefined

  const jumpThreshold = (el: HTMLDivElement) => Math.max(400, el.clientHeight)

  const updateScrollState = (el: HTMLDivElement) => {
    const max = el.scrollHeight - el.clientHeight
    const distance = max - el.scrollTop
    const overflow = max > 1
    const bottom = !overflow || distance <= 2
    const jump = overflow && distance > jumpThreshold(el)

    if (ui.scroll.overflow === overflow && ui.scroll.bottom === bottom && ui.scroll.jump === jump) return
    setUi("scroll", { overflow, bottom, jump })
  }

  const scheduleScrollState = (el: HTMLDivElement) => {
    scrollStateTarget = el
    if (scrollStateFrame !== undefined) return

    scrollStateFrame = requestAnimationFrame(() => {
      scrollStateFrame = undefined

      const target = scrollStateTarget
      scrollStateTarget = undefined
      if (!target) return

      updateScrollState(target)
    })
  }

  const resumeScroll = () => {
    setStore("messageId", undefined)
    autoScroll.resume()
    scrollToEnd()
    clearMessageHash()

    const el = scroller
    if (el) scheduleScrollState(el)
  }

  // When the user returns to the bottom, treat the active message as "latest".
  createEffect(
    on(
      autoScroll.userScrolled,
      (scrolled) => {
        if (scrolled) return
        setStore("messageId", undefined)
        clearMessageHash()
      },
      { defer: true },
    ),
  )

  let fill = () => {}

  const setScrollRef = (el: HTMLDivElement | undefined) => {
    scroller = el
    autoScroll.scrollRef(el)
    if (!el) return
    scheduleScrollState(el)
    fill()
  }

  const markUserScroll = () => {
    scrollMark += 1
  }

  createResizeObserver(
    () => content,
    () => {
      const el = scroller
      if (el) scheduleScrollState(el)
      fill()
    },
  )

  let captureHistoryAnchor = () => {}
  let restoreHistoryAnchor = (_done: boolean) => {}
  const historyRequests = new Set<string>()
  let historyContinuationFrame: number | undefined
  const loadOlder = async () => {
    const owner = sessionOwnership.capture()
    if (historyLoading() || historyRequests.has(owner.key)) return
    historyRequests.add(owner.key)
    const before = timeline.messages().length
    try {
      await timeline.history.loadOlder({
        before: () => owner.run(captureHistoryAnchor),
        after: (done) => owner.run(() => restoreHistoryAnchor(done)),
      })
    } finally {
      historyRequests.delete(owner.key)
    }
    if (!owner.current() || timeline.messages().length <= before) return
    if (!autoScroll.userScrolled() || !scroller || scroller.scrollTop >= 200 || !historyMore()) return
    if (historyContinuationFrame !== undefined) cancelAnimationFrame(historyContinuationFrame)
    historyContinuationFrame = requestAnimationFrame(() => {
      historyContinuationFrame = undefined
      owner.run(onHistoryScroll)
    })
  }
  const onHistoryScroll = () => {
    if (
      historyRequests.has(sessionOwnership.key()) ||
      historyLoading() ||
      !autoScroll.userScrolled() ||
      !scroller ||
      scroller.scrollTop >= 200
    )
      return
    void loadOlder()
  }

  onCleanup(() => {
    if (historyContinuationFrame !== undefined) cancelAnimationFrame(historyContinuationFrame)
  })

  fill = () => {
    if (fillFrame !== undefined) return

    fillFrame = requestAnimationFrame(() => {
      fillFrame = undefined

      if (!params.id || !messagesReady()) return
      if (autoScroll.userScrolled() || historyLoading()) return

      const el = scroller
      if (!el) return
      if (el.scrollHeight > el.clientHeight + 1) return
      if (!historyMore()) return

      void loadOlder()
    })
  }

  createEffect(
    on(
      () =>
        [
          params.id,
          messagesReady(),
          historyMore(),
          historyLoading(),
          autoScroll.userScrolled(),
          visibleUserMessages().length,
        ] as const,
      ([id, ready, more, loading, scrolled]) => {
        if (!id || !ready || loading || scrolled) return
        if (!more) return
        fill()
      },
      { defer: true },
    ),
  )

  const draft = (id: string) =>
    extractPromptFromParts(sync().data.part[id] ?? [], {
      directory: sdk().directory,
      attachmentName: language.t("common.attachment"),
    })

  const line = (id: string) => {
    const text = draft(id)
      .map((part) => (part.type === "image" ? `[image:${part.filename}]` : part.content))
      .join("")
      .replace(/\s+/g, " ")
      .trim()
    if (text) return text
    return `[${language.t("common.attachment")}]`
  }

  const fail = (err: unknown) => {
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: formatServerError(err, language.t),
    })
  }

  const merge = (next: NonNullable<ReturnType<typeof info>>, target = sync()) => target.session.remember(next)

  const roll = (sessionID: string, next: NonNullable<ReturnType<typeof info>>["revert"], target = sync()) => {
    const session = target.session.get(sessionID)
    if (!session) return
    target.session.remember({ ...session, revert: next })
  }

  const busy = (sessionID: string) => sync().data.session_working(sessionID)

  const queuedFollowups = createMemo(() => {
    const id = params.id
    if (!id) return emptyFollowups
    return followup.items[id] ?? emptyFollowups
  })

  const editingFollowup = createMemo(() => {
    const id = params.id
    if (!id) return
    return followup.edit[id]
  })

  const followupMutation = useMutation(() => ({
    mutationFn: async (input: { sessionID: string; id: string; manual?: boolean }) => {
      const owner = sessionOwnership.capture()
      const item = (followup.items[input.sessionID] ?? []).find((entry) => entry.id === input.id)
      if (!item) return

      if (input.manual) setFollowup("paused", input.sessionID, undefined)
      setFollowup("failed", input.sessionID, undefined)

      const ok = await sendFollowupDraft({
        client: sdk().client,
        sync: sync(),
        serverSync: serverSync(),
        draft: item,
        optimisticBusy: item.sessionDirectory === sdk().directory,
        openProjectDirectories: layout.projects.list().map((project) => project.worktree),
      }).catch((err) => {
        setFollowup("failed", input.sessionID, input.id)
        fail(err)
        return false
      })
      if (!ok) return

      setFollowup("items", input.sessionID, (items) => (items ?? []).filter((entry) => entry.id !== input.id))
      if (input.manual) owner.run(resumeScroll)
    },
  }))

  const followupBusy = (sessionID: string) =>
    followupMutation.isPending && followupMutation.variables?.sessionID === sessionID

  const sendingFollowup = createMemo(() => {
    const id = params.id
    if (!id) return
    if (!followupBusy(id)) return
    return followupMutation.variables?.id
  })

  const queueEnabled = createMemo(() => {
    const id = params.id
    if (!id) return false
    return settings.general.followup() === "queue" && busy(id) && !composer.blocked() && !isChildSession()
  })

  const followupText = (item: FollowupDraft) => {
    const text = item.prompt
      .map((part) => {
        if (part.type === "image") return `[image:${part.filename}]`
        if (part.type === "file") return `[file:${part.path}]`
        if (part.type === "agent") return `@${part.name}`
        return part.content
      })
      .join("")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => !!line)

    if (text) return text
    return `[${language.t("common.attachment")}]`
  }

  const queueFollowup = (draft: FollowupDraft) => {
    setFollowup("items", draft.sessionID, (items) => [
      ...(items ?? []),
      { id: Identifier.ascending("message"), ...draft },
    ])
    setFollowup("failed", draft.sessionID, undefined)
    setFollowup("paused", draft.sessionID, undefined)
  }

  const followupDock = createMemo(() => queuedFollowups().map((item) => ({ id: item.id, text: followupText(item) })))

  const sendFollowup = (sessionID: string, id: string, opts?: { manual?: boolean }) => {
    if (sync().session.get(sessionID)?.parentID) return Promise.resolve()
    const item = (followup.items[sessionID] ?? []).find((entry) => entry.id === id)
    if (!item) return Promise.resolve()
    if (followupBusy(sessionID)) return Promise.resolve()

    return followupMutation.mutateAsync({ sessionID, id, manual: opts?.manual })
  }

  const editFollowup = (id: string) => {
    const sessionID = params.id
    if (!sessionID) return
    if (followupBusy(sessionID)) return

    const item = queuedFollowups().find((entry) => entry.id === id)
    if (!item) return

    setFollowup("items", sessionID, (items) => (items ?? []).filter((entry) => entry.id !== id))
    setFollowup("failed", sessionID, (value) => (value === id ? undefined : value))
    setFollowup("edit", sessionID, {
      id: item.id,
      prompt: item.prompt,
      context: item.context,
    })
  }

  const clearFollowupEdit = () => {
    const id = params.id
    if (!id) return
    setFollowup("edit", id, undefined)
  }

  const halt = (sessionID: string) =>
    busy(sessionID)
      ? sdk()
          .client.session.abort({ sessionID })
          .catch(() => {})
      : Promise.resolve()

  const revertMutation = useMutation(() => ({
    mutationFn: async (input: { sessionID: string; messageID: string }) => {
      const client = sdk().client
      const target = sync()
      const last = target.session.get(input.sessionID)?.revert
      const value = draft(input.messageID)
      await runPromptRollbackMutation({
        capturePrompt: prompt.capture,
        optimistic: (prompt) => {
          roll(input.sessionID, { messageID: input.messageID }, target)
          prompt.set(value)
        },
        request: () => halt(input.sessionID).then(() => client.session.revert(input)),
        complete: (result) => {
          if (result.data) merge(result.data, target)
        },
        rollback: () => roll(input.sessionID, last, target),
        fail,
      })
    },
  }))

  const restoreMutation = useMutation(() => ({
    mutationFn: async (id: string) => {
      const sessionID = params.id
      if (!sessionID) return

      const client = sdk().client
      const target = sync()
      const next = userMessages().find((item) => item.id > id)
      const last = target.session.get(sessionID)?.revert

      await runPromptRollbackMutation({
        capturePrompt: prompt.capture,
        optimistic: (promptSession) => {
          roll(sessionID, next ? { messageID: next.id } : undefined, target)
          if (next) {
            promptSession.set(draft(next.id))
            return
          }
          promptSession.reset()
        },
        request: () =>
          !next
            ? halt(sessionID).then(() => client.session.unrevert({ sessionID }))
            : halt(sessionID).then(() => client.session.revert({ sessionID, messageID: next.id })),
        complete: (result) => {
          if (result.data) merge(result.data, target)
        },
        rollback: () => roll(sessionID, last, target),
        fail,
      })
    },
  }))

  const reverting = createMemo(() => revertMutation.isPending || restoreMutation.isPending)
  const restoring = createMemo(() => (restoreMutation.isPending ? restoreMutation.variables : undefined))

  const revert = (input: { sessionID: string; messageID: string }) => {
    if (reverting()) return
    return revertMutation.mutateAsync(input)
  }

  const replay = async (input: { sessionID: string; messageID: string }) => {
    if (reverting()) return
    const message = userMessages().find((item) => item.id === input.messageID)
    if (!message) return

    const value = draft(input.messageID)
    const text = value.map((part) => ("content" in part ? part.content : "")).join("")
    const images = value.filter((part) => part.type === "image")
    if (text.trim().length === 0 && images.length === 0) return

    await revertMutation.mutateAsync(input)
    if (sync().session.get(input.sessionID)?.revert?.messageID !== input.messageID) return

    const agent = local.agent.current()?.name
    const current = local.model.current()
    if (!agent || !current) {
      showToast({
        title: language.t("prompt.toast.modelAgentRequired.title"),
        description: language.t("prompt.toast.modelAgentRequired.description"),
      })
      return
    }

    const directory = sdk().directory
    const promptSession = prompt.capture()
    promptSession.reset()
    resumeScroll()
    await sendFollowupDraft({
      client: sdk().client,
      sync: sync(),
      serverSync: serverSync(),
      draft: {
        sessionID: input.sessionID,
        sessionDirectory: directory,
        prompt: value,
        context: [],
        agent,
        model: { providerID: current.provider.id, modelID: current.id },
        variant: local.model.variant.current(),
      },
      optimisticBusy: true,
      openProjectDirectories: layout.projects.list().map((project) => project.worktree),
    }).catch((err) => {
      fail(err)
      promptSession.set(value)
    })
  }

  const restore = (id: string) => {
    if (!params.id || reverting()) return
    return restoreMutation.mutateAsync(id)
  }

  const rolled = createMemo(() => {
    const id = revertMessageID()
    if (!id) return []
    return userMessages()
      .filter((item) => item.id >= id)
      .map((item) => ({ id: item.id, text: line(item.id) }))
  })

  // attachment bytes are embedded as a data URL, so downloading always works;
  // revealing requires the on-disk path captured by the client that attached the file
  const openAttachment = (file: FilePart) => {
    const download = () => {
      const anchor = document.createElement("a")
      anchor.href = file.url
      anchor.download = getFilename(file.filename) || "attachment"
      anchor.click()
    }
    const path = file.filename ?? ""
    const absolute = path.startsWith("/") || path.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(path)
    if (platform.revealPath && absolute) {
      void platform.revealPath(path).then(
        (revealed) => {
          if (!revealed) download()
        },
        () => download(),
      )
      return
    }
    download()
  }

  const actions = { revert, replay, openAttachment }

  createEffect(() => {
    const sessionID = params.id
    if (!sessionID) return

    const item = queuedFollowups()[0]
    if (!item) return
    if (followupBusy(sessionID)) return
    if (followup.failed[sessionID] === item.id) return
    if (followup.paused[sessionID]) return
    if (isChildSession()) return
    if (composer.blocked()) return
    if (busy(sessionID)) return

    void sendFollowup(sessionID, item.id)
  })

  createResizeObserver(
    () => promptDock,
    ({ height }) => {
      const next = Math.ceil(height)

      if (next === dockHeight) return

      const el = scroller
      const delta = next - dockHeight
      const stick = el
        ? !autoScroll.userScrolled() || el.scrollHeight - el.clientHeight - el.scrollTop < 10 + Math.max(0, delta)
        : false

      dockHeight = next

      if (stick) scrollToEnd()

      if (el) scheduleScrollState(el)
      fill()
    },
  )

  const { clearMessageHash, scrollToMessage } = useSessionHashScroll({
    sessionKey,
    sessionID: () => params.id,
    messagesReady,
    visibleUserMessages,
    historyMore,
    historyLoading,
    loadMore: (sessionID) => sync().session.history.loadMore(sessionID),
    currentMessageId: () => store.messageId,
    pendingMessage: () => ui.pendingMessage,
    setPendingMessage: (value) => setUi("pendingMessage", value),
    setActiveMessage,
    autoScroll: {
      pause: autoScroll.pause,
      forceScrollToBottom: () => {
        autoScroll.resume()
        scrollToEnd()
      },
    },
    scroller: () => scroller,
    anchor,
    revealMessage: (id) => revealMessage(id),
    scheduleScrollState,
    consumePendingMessage: layout.pendingMessage.consume,
  })

  createEffect(
    on(
      () => params.id,
      (id) => {
        if (!id) requestAnimationFrame(() => inputRef?.focus())
      },
    ),
  )

  onMount(() => {
    makeEventListener(document, "keydown", handleKeyDown)
  })

  onCleanup(() => {
    clearSessionFindHighlights()
    if (todoFrame !== undefined) cancelAnimationFrame(todoFrame)
    if (todoTimer !== undefined) window.clearTimeout(todoTimer)
    if (scrollStateFrame !== undefined) cancelAnimationFrame(scrollStateFrame)
    if (fillFrame !== undefined) cancelAnimationFrame(fillFrame)
  })

  useUsageExceededDialogs()

  const sessionPanelContent = () => (
    <>
      <div class="relative flex-1 min-h-0 overflow-hidden">
        <SessionFindBar
          open={findOpen()}
          focusToken={findFocus()}
          query={findQuery()}
          matchIndex={findIndex()}
          matchCount={findMatches().length}
          onQuery={setFindQuery}
          onClose={closeFind}
          onNext={findNext}
          onPrev={findPrev}
        />
        <Switch>
          <Match when={params.id}>
            {/* Always key on session id so chat remounts even while messages are still loading. */}
            <Show when={params.id} keyed>
              {(_id) => (
                <Show when={messagesReady()}>
                  <MessageTimeline
                    actions={actions}
                    scroll={ui.scroll}
                    onResumeScroll={resumeScroll}
                    setScrollRef={setScrollRef}
                    onScheduleScrollState={scheduleScrollState}
                    onAutoScrollHandleScroll={autoScroll.handleScroll}
                    onMarkScrollGesture={markScrollGesture}
                    hasScrollGesture={hasScrollGesture}
                    onUserScroll={markUserScroll}
                    onHistoryScroll={onHistoryScroll}
                    onAutoScrollInteraction={autoScroll.handleInteraction}
                    shouldAnchorBottom={() =>
                      !location.hash && !store.messageId && !ui.pendingMessage && !autoScroll.userScrolled()
                    }
                    centered={centered()}
                    setContentRef={(el) => {
                      content = el
                      autoScroll.contentRef(el)

                      const root = scroller
                      if (root) scheduleScrollState(root)
                    }}
                    userMessages={visibleUserMessages()}
                    setHistoryAnchor={(handlers) => {
                      captureHistoryAnchor = handlers.capture
                      restoreHistoryAnchor = handlers.restore
                    }}
                    anchor={anchor}
                    setRevealMessage={(fn) => {
                      revealMessage = fn
                    }}
                    setScrollToEnd={(fn) => {
                      scrollToEnd = fn
                    }}
                  />
                </Show>
              )}
            </Show>
          </Match>
          <Match when={true}>
            <NewSessionView worktree={newSessionWorktree()} />
          </Match>
        </Switch>
      </div>

      {(() => {
        const controller = createSessionComposerRegionController({
          state: composer,
          sessionKey,
          sessionID: () => params.id,
          prompt,
          ready: () => !store.deferRender && messagesReady(),
          centered,
          todo: {
            collapsed: () => view().todoCollapsed.get(),
            onToggle: () => view().todoCollapsed.set(!view().todoCollapsed.get()),
          },
          followup: () =>
            params.id && !isChildSession()
              ? {
                  items: followupDock(),
                  sending: sendingFollowup(),
                  onSend: (id) => void sendFollowup(params.id!, id, { manual: true }),
                  onEdit: editFollowup,
                }
              : undefined,
          revert: () =>
            rolled().length > 0
              ? {
                  items: rolled(),
                  restoring: restoring(),
                  disabled: reverting(),
                  onRestore: restore,
                }
              : undefined,
          onResponseSubmit: resumeScroll,
          openParent: () => {
            const id = info()?.parentID
            if (!id) return
            navigate(
              params.serverKey
                ? sessionHref(requireServerKey(params.serverKey), id)
                : legacySessionHref(sdk().directory, id),
            )
          },
          setPromptRef: (el) => {
            inputRef = el
          },
          setDockRef: (el) => {
            promptDock = el
          },
        })
        return (
          <SessionComposerRegion
            controller={controller}
            promptInput={
              <PromptInput
                controls={inputController()}
                ref={(el) => {
                  inputRef = el
                }}
                newSessionWorktree={newSessionWorktree()}
                onNewSessionWorktreeReset={() => setStore("newSessionWorktree", "main")}
                onSubmit={() => {
                  comments.clear()
                  resumeScroll()
                }}
                edit={editingFollowup()}
                onEditLoaded={clearFollowupEdit}
                shouldQueue={queueEnabled}
                onQueue={queueFollowup}
                onAbort={() => {
                  const id = params.id
                  if (!id) return
                  setFollowup("paused", id, true)
                }}
              />
            }
          />
        )
      })()}
    </>
  )

  return (
    <SessionRouteFrame>
      <SessionHeader />
      <div
        ref={panelRow}
        classList={{
          "flex-1 min-h-0 flex flex-col": true,
          "flex-row": isDesktop(),
        }}
      >
        <Show when={!mobileContextOpen()}>
          <div
            classList={{
              "@container relative shrink-0 flex flex-col min-h-0 h-full transition-[width]": true,
              "flex-1": !isDesktop(),
              "flex-none": isDesktop(),
              "duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
                !size.active(),
            }}
            style={{
              width: sessionPanelWidth(),
            }}
          >
            <SessionPanelFrame>{sessionPanelContent()}</SessionPanelFrame>
          </div>
        </Show>

        <Show when={desktopSidePanelOpen() || mobileContextOpen()}>
          <SessionSidePanel
            size={size}
            sessionWidth={sessionPanelResizedWidth}
            sessionWidthMin={SESSION_PANEL_WIDTH_MIN}
            sessionWidthMax={sessionPanelMax}
            availableWidth={sessionPanelAvailable}
            onSessionResize={(width) => setSessionDragWidth(width)}
            onSessionResizeEnd={(width) => {
              layout.session.resize(width)
              setSessionDragWidth(undefined)
            }}
          />
        </Show>
      </div>

      <TerminalPanel />
    </SessionRouteFrame>
  )
}
