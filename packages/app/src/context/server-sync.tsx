import type {
  Config,
  McpResource,
  OpencodeClient,
  Path,
  Project,
  ProviderAuthResponse,
} from "@opencode-ai/sdk/v2/client"
import { showToast } from "@/utils/toast"
import { getFilename } from "@opencode-ai/core/util/path"
import { type Accessor, batch, createMemo, getOwner, onCleanup, onMount, untrack } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { InitError } from "../pages/error"
import { ServerSDK } from "./server-sdk"
import {
  bootstrapDirectory,
  bootstrapGlobal,
  loadGlobalConfigQuery,
  loadPathQuery,
  loadProjectsQuery,
  loadReferencesQuery,
} from "./global-sync/bootstrap"
import { createChildStoreManager } from "./global-sync/child-store"
import { applyDirectoryEvent, applyGlobalEvent } from "./global-sync/event-reducer"
import { loadRootSessionsWithFallback } from "./global-sync/session-load"
import type { ProjectMeta } from "./global-sync/types"
import { SESSION_LIST_LIMIT } from "./global-sync/types"
import { formatServerError } from "@/utils/server-errors"
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/solid-query"
import { createRefreshQueue } from "./global-sync/queue"
import { directoryKey } from "./global-sync/utils"
import { PathKey } from "@/utils/path-key"
import { createDirSyncContext } from "./directory-sync"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createRefCountMap } from "@/utils/refcount"
import { useGlobal } from "./global"
import { ServerConnection, useServer } from "./server"
import { retry } from "@opencode-ai/core/util/retry"
import type { ServerScope } from "@/utils/server-scope"
import { createHomeSessionIndexCache } from "./global-sync/home-session-index"
import { persisted } from "@/utils/persist"
import { toggleMcp } from "./global-sync/mcp"
import { createServerSession } from "./server-session"

type GlobalStore = {
  ready: boolean
  error?: InitError
  path: Path
  project: Project[]
  provider_auth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
}

export const loadMcpQuery = (scope: ServerScope, directory: string, sdk: OpencodeClient) =>
  queryOptions({
    queryKey: [scope, directory, "mcp"] as const,
    queryFn: () => sdk.mcp.status().then((r) => r.data ?? {}),
  })

export const loadMcpResourcesQuery = (scope: ServerScope, directory: string, sdk: OpencodeClient) =>
  queryOptions<Record<string, McpResource>>({
    queryKey: [scope, directory, "mcpResources"] as const,
    queryFn: () => sdk.experimental.resource.list().then((r) => r.data ?? {}),
    placeholderData: {},
  })

function makeQueryOptionsApi(
  scope: ServerScope,
  serverSDK: () => OpencodeClient,
  sdkFor: (dir: PathKey) => OpencodeClient,
) {
  return {
    globalConfig: () => loadGlobalConfigQuery(scope, serverSDK()),
    projects: () => loadProjectsQuery(scope, serverSDK()),
    path: (directory: PathKey | null) =>
      loadPathQuery(scope, directory, directory === null ? serverSDK() : sdkFor(directory)),
    references: (directory: PathKey) => loadReferencesQuery(scope, directory, sdkFor(directory)),
    mcp: (directory: PathKey) => loadMcpQuery(scope, directory, sdkFor(directory)),
    mcpResources: (directory: PathKey) => loadMcpResourcesQuery(scope, directory, sdkFor(directory)),
    sessions: (directory: PathKey) => ({ queryKey: [scope, directory, "loadSessions"] as const }),
  }
}
export type QueryOptionsApi = ReturnType<typeof makeQueryOptionsApi>

export function createServerSyncContextInner(serverSDK: ServerSDK) {
  const language = useLanguage()
  const owner = getOwner()
  if (!owner) throw new Error("ServerSync must be created within owner")

  const sdkCache = new Map<string, OpencodeClient>()
  const booting = new Map<string, Promise<void>>()
  const sessionLoads = new Map<string, Promise<void>>()
  const sessionsLoaded = new Set<string>()

  const sdkFor = (directory: string) => {
    const key = directoryKey(directory)
    const cached = sdkCache.get(key)
    if (cached) return cached
    const sdk = serverSDK.createClient({
      directory,
      throwOnError: true,
    })
    sdkCache.set(key, sdk)
    return sdk
  }

  const queryOptionsApi = makeQueryOptionsApi(serverSDK.scope, () => serverSDK.client, sdkFor)

  const configQuery = useQuery(() => queryOptionsApi.globalConfig())
  const pathQuery = useQuery(() => queryOptionsApi.path(null))

  const [globalStore, setGlobalStore] = createStore<GlobalStore>({
    get ready() {
      return !bootstrap.isPending
    },
    project: [],
    provider_auth: {},
    get path() {
      const EMPTY = {
        state: "",
        config: "",
        worktree: "",
        directory: "",
        home: "",
        data: "",
        cache: "",
        log: "",
        database: { path: "", data: "", tables: [] },
      }
      if (pathQuery.isLoading) return EMPTY
      return pathQuery.data ?? EMPTY
    },
    get config() {
      if (configQuery.isLoading) return {}
      return configQuery.data ?? {}
    },
    get reload() {
      return updateConfigMutation.isPending ? "pending" : undefined
    },
  })

  const queryClient = useQueryClient()
  const homeSessions = createHomeSessionIndexCache(queryClient, ServerConnection.key(serverSDK.server))

  let bootedAt = 0
  let bootingRoot = false
  let eventFrame: number | undefined
  let eventTimer: ReturnType<typeof setTimeout> | undefined

  onCleanup(() => {
    if (eventFrame !== undefined) cancelAnimationFrame(eventFrame)
    if (eventTimer !== undefined) clearTimeout(eventTimer)
  })

  const setProjects = (next: Project[] | ((draft: Project[]) => Project[])) => {
    setGlobalStore("project", next)
  }

  const setBootStore = ((...input: unknown[]) => {
    if (input[0] === "project" && Array.isArray(input[1])) {
      setProjects(input[1] as Project[])
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  const bootstrap = useQuery(() => ({
    queryKey: [serverSDK.scope, "bootstrap"],
    queryFn: async () => {
      // 标记全局 bootstrap 进行中 — 让 server.connected 监听器在启动阶段
      // 跳过二次全量刷新，否则会重复触发每个目录的 bootstrapInstance。
      bootingRoot = true
      try {
        await bootstrapGlobal({
          serverSDK: serverSDK.client,
          scope: serverSDK.scope,
          requestFailedTitle: language.t("common.requestFailed"),
          translate: language.t,
          formatMoreCount: (count) => language.t("common.moreCountSuffix", { count }),
          setGlobalStore: setBootStore,
          queryClient,
        })
        bootedAt = Date.now()
        return bootedAt
      } finally {
        bootingRoot = false
      }
    },
  }))

  const set = ((...input: unknown[]) => {
    if (input[0] === "project" && (Array.isArray(input[1]) || typeof input[1] === "function")) {
      setProjects(input[1] as Project[] | ((draft: Project[]) => Project[]))
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  const paused = () => untrack(() => globalStore.reload) !== undefined

  const queue = createRefreshQueue({
    paused,
    key: directoryKey,
    bootstrap: () => queryClient.fetchQuery({ queryKey: [serverSDK.scope, "bootstrap"] }),
    bootstrapInstance,
  })

  const session = createServerSession(serverSDK.client)

  const children = createChildStoreManager({
    owner,
    scope: serverSDK.scope,
    persist: persisted,
    isBooting: (directory) => booting.has(directory),
    isLoadingSessions: (directory) => sessionLoads.has(directory),
    onBootstrap: (directory, onReady) => {
      void bootstrapInstance(directory, onReady)
    },
    onMcp: (directory, setStore) => {
      void retry(() =>
        sdkFor(directory)
          .command.list()
          .then((x) => setStore("command", x.data ?? [])),
      ).catch((err) => {
        showToast({
          variant: "error",
          title: language.t("toast.project.reloadFailed.title", { project: getFilename(directory) }),
          description: formatServerError(err, language.t),
        })
      })
    },
    onDispose: (directory) => {
      const key = directoryKey(directory)
      queue.clear(key)
      sessionsLoaded.delete(key)
      sdkCache.delete(key)
    },
    translate: language.t,
    queryOptions: queryOptionsApi,
    global: {},
  })

  async function loadSessions(directory: string) {
    const key = directoryKey(directory)
    const pending = sessionLoads.get(key)
    if (pending) {
      await pending
      return loadSessions(directory)
    }

    children.pin(key)
    const [store, setStore] = children.child(directory, { bootstrap: false })
    if (sessionsLoaded.has(key)) {
      children.unpin(key)
      return
    }

    const promise = queryClient
      .fetchQuery({
        ...queryOptionsApi.sessions(key),
        queryFn: () =>
          loadRootSessionsWithFallback({
            directory,
            limit: SESSION_LIST_LIMIT,
            list: (query) => serverSDK.client.session.list(query),
          })
            .then((x) => {
              const nonArchived = (x.data ?? [])
                .filter((s) => !!s?.id)
                .filter((s) => !s.time?.archived)
                .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
              const childSessions = store.session.filter((s) => !!s.parentID)
              const next = [...nonArchived, ...childSessions].sort((a, b) =>
                a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
              )
              batch(() => {
                next.forEach(session.remember)
                setStore("session", reconcile(next, { key: "id" }))
              })
              sessionsLoaded.add(key)
            })
            .catch((err) => {
              console.error("Failed to load sessions", err)
              const project = getFilename(directory)
              showToast({
                variant: "error",
                title: language.t("toast.session.listFailed.title", { project }),
                description: formatServerError(err, language.t),
              })
            })
            .then(() => null),
      })
      .then(() => {})

    sessionLoads.set(key, promise)
    void promise.finally(() => {
      sessionLoads.delete(key)
      children.unpin(key)
    })
    return promise
  }

  // 首屏会同时拉起所有侧边栏项目的 instance bootstrap；并发太高会让每个请求都变慢，
  // 且服务端 InstanceStore.load（git discover + config + LSP 等）会互相抢占。
  // 限流到 3 个并发保证首屏可见性，剩余的排进等待队列。
  const BOOTSTRAP_CONCURRENCY = 3
  const waiting: Array<() => void> = []
  let inFlight = 0

  function acquireSlot() {
    if (inFlight < BOOTSTRAP_CONCURRENCY) {
      inFlight += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      waiting.push(resolve)
    })
  }

  function releaseSlot() {
    const next = waiting.shift()
    if (next) {
      next()
      return
    }
    inFlight -= 1
  }

  async function bootstrapInstance(directory: string, onReady?: () => void) {
    const key = directoryKey(directory)
    if (!key) return
    const pending = booting.get(key)
    if (pending) {
      // 已有进行中的 bootstrap：把 onReady 追加到当前 promise 尾部，
      // 这样 activate() 会在拿到槽位（即首个 bootstrap 已 occupy socket）后才触发。
      if (onReady) void pending.then(onReady)
      return pending
    }

    children.pin(key)
    const started = Date.now()
    const promise = acquireSlot()
      .then(async () => {
        const waited = Date.now() - started
        if (waited > 50) console.log(`[bootstrap] ${key} waited ${waited}ms for slot`)
        // 拿到槽位后才允许 provider/reference observer 启动 — 不然它们会
        // 在 sessions/critical 之前先把 Chromium socket pool 占满。
        onReady?.()
        const child = children.ensureChild(directory)
        const sdk = sdkFor(directory)
        await bootstrapDirectory({
          directory,
          scope: serverSDK.scope,
          mcp: children.mcp(key),
          global: {
            config: globalStore.config,
            path: globalStore.path,
            project: globalStore.project,
          },
          sdk,
          store: child[0],
          setStore: child[1],
          loadSessions,
          translate: language.t,
          queryClient,
          session,
        })
        console.log(`[bootstrap] ${key} done in ${Date.now() - started}ms`)
      })
      .finally(releaseSlot)

    booting.set(key, promise)
    void promise.finally(() => {
      booting.delete(key)
      children.unpin(key)
    })
    return promise
  }

  const unsub = serverSDK.event.listen((e) => {
    const directory = e.name
    const key = directoryKey(directory)
    const event = e.details
    const recent = bootingRoot || Date.now() - bootedAt < 1500

    session.apply(event)
    if (event.type === "session.created" || event.type === "session.updated" || event.type === "session.deleted") {
      homeSessions.apply(event)
    }
    homeSessions.refresh(event.type)

    if (directory === "global") {
      applyGlobalEvent({
        event,
        project: globalStore.project,
        refresh: () => {
          if (recent) return
          bootstrap.refetch()
        },
        setGlobalProject: setProjects,
      })
      if (event.type === "server.connected" || event.type === "global.disposed") {
        // 启动阶段（global bootstrap 或任意 instance bootstrap 还在跑）不重复
        // 触发全量刷新 — 启动流程本身会拉取这些数据，重复触发只会浪费 socket。
        if (recent) return
        if (booting.size > 0) return
        for (const directory of Object.keys(children.children)) {
          if (!children.active(directory)) continue
          queue.push(directory)
        }
      }
      return
    }

    const existing = children.children[key]
    if (!existing) return
    children.mark(key)
    const [store, setStore] = existing
    applyDirectoryEvent({
      event,
      directory,
      store,
      setStore,
      push: (directory) => {
        if (children.active(directory)) queue.push(directory)
      },
      sessionContent: false,
      loadReferences: () => {
        if (!children.active(key)) return
        void queryClient.fetchQuery(queryOptionsApi.references(key))
      },
    })
  })

  onCleanup(unsub)
  onCleanup(() => {
    queue.dispose()
  })
  onCleanup(() => {
    for (const directory of Object.keys(children.children)) {
      children.disposeDirectory(directoryKey(directory))
    }
  })

  onMount(() => {
    if (typeof requestAnimationFrame === "function") {
      eventFrame = requestAnimationFrame(() => {
        eventFrame = undefined
        eventTimer = setTimeout(() => {
          eventTimer = undefined
          void serverSDK.event.start()
        }, 0)
      })
    } else {
      eventTimer = setTimeout(() => {
        eventTimer = undefined
        void serverSDK.event.start()
      }, 0)
    }
  })

  const projectApi = {
    loadSessions,
    meta(directory: string, patch: ProjectMeta) {
      children.projectMeta(directory, patch)
    },
    icon(directory: string, value: string | undefined) {
      children.projectIcon(directory, value)
    },
  }

  const updateConfigMutation = useMutation(() => ({
    mutationFn: (config: Config) => serverSDK.client.global.config.update({ config }),
    onSuccess: (res, variables) => {
      // PATCH 成功后先用本次顶层配置覆盖缓存，避免弹窗重挂载时仍读取旧列表。
      queryClient.setQueryData([serverSDK.scope, "config"], {
        ...(res.data ?? globalStore.config),
        ...variables,
      })
      bootstrap.refetch()
      // provider 列表完全由 config.provider 派生，invalidate config 就够
      queryClient.invalidateQueries({ queryKey: [serverSDK.scope, "config"] })
    },
  }))

  return {
    data: globalStore,
    set,
    get ready() {
      return globalStore.ready
    },
    get error() {
      return globalStore.error
    },
    child: children.child,
    peek: children.peek,
    disableMcp: children.disableMcp,
    queryOptions: queryOptionsApi,
    // bootstrap,
    updateConfig: updateConfigMutation.mutateAsync,
    project: projectApi,
    session,
    homeSessions,
    mcp: {
      toggle: async (directory: string, name: string) => {
        const key = directoryKey(directory)
        const sdk = sdkFor(key)
        const status = children.child(key, { bootstrap: false })[0].mcp[name].status
        await toggleMcp({
          status,
          connect: async () => {
            await sdk.mcp.connect({ name })
          },
          disconnect: async () => {
            await sdk.mcp.disconnect({ name })
          },
          authenticate: async () => {
            await sdk.mcp.auth.authenticate({ name })
          },
          refresh: async () => {
            await queryClient.refetchQueries(queryOptionsApi.mcp(key))
            await queryClient.refetchQueries(queryOptionsApi.mcpResources(key))
          },
        })
      },
    },
  }
}

export function createServerSyncContext(serverSDK: ServerSDK) {
  const inner = createServerSyncContextInner(serverSDK)
  return Object.assign(inner, {
    ensureDirSyncContext: createRefCountMap(
      (dir) => createDirSyncContext(dir, inner, serverSDK),
      (dir) => inner.disableMcp(dir),
      directoryKey,
    ),
  })
}

export type ServerSync = ReturnType<typeof createServerSyncContext>

export const { use: useServerSync, provider: ServerSyncProvider } = createSimpleContext({
  name: "ServerSync",
  // Returns an accessor so the resolved server can change reactively without
  // re-instantiating the subtree (mirrors useServerSDK).
  init: (props: { server?: Accessor<ServerConnection.Any | undefined> }) => {
    const global = useGlobal()
    const language = useLanguage()
    const server = useServer()

    return createMemo<ServerSync>(() => {
      const conn = props.server?.() ?? server.current
      if (!conn) throw new Error(language.t("error.serverSDK.noServerAvailable"))
      return global.ensureServerCtx(conn).sync
    })
  },
})

export function useQueryOptions() {
  const sync = useServerSync()
  return createMemo(() => sync().queryOptions)
}
