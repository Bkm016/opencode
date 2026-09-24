import type {
  Config,
  OpencodeClient,
  Path,
  PermissionRequest,
  Project,
  ProviderAuthResponse,
  QuestionRequest,
  ReferenceInfo,
  Session,
} from "@opencode-ai/sdk/v2/client"
import { showToast } from "@/utils/toast"
import { getFilename } from "@opencode-ai/core/util/path"
import { retry } from "@opencode-ai/core/util/retry"
import { batch } from "solid-js"
import { produce, reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import type { State } from "./types"
import type { ServerSession } from "../server-session"
import { cmp, normalizeAgentList } from "./utils"
import { formatServerError } from "@/utils/server-errors"
import { QueryClient, queryOptions } from "@tanstack/solid-query"
import { loadMcpQuery, loadMcpResourcesQuery } from "../server-sync"
import type { ServerScope } from "@/utils/server-scope"
import { directoryKey } from "./utils"

type GlobalStore = {
  ready: boolean
  path: Path
  project: Project[]
  provider_auth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
}

function waitForPaint() {
  return new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    const timer = setTimeout(finish, 50)
    if (typeof requestAnimationFrame !== "function") return
    requestAnimationFrame(() => {
      setTimeout(() => {
        clearTimeout(timer)
        finish()
      }, 0)
    })
  })
}

function errors(list: PromiseSettledResult<unknown>[]) {
  return list.filter((item): item is PromiseRejectedResult => item.status === "rejected").map((item) => item.reason)
}

function runAll(list: Array<() => Promise<unknown>>) {
  return Promise.allSettled(list.map((item) => item()))
}

function showErrors(input: {
  errors: unknown[]
  title: string
  translate: (key: string, vars?: Record<string, string | number>) => string
  formatMoreCount: (count: number) => string
}) {
  if (input.errors.length === 0) return
  const message = formatServerError(input.errors[0], input.translate)
  const more = input.errors.length > 1 ? input.formatMoreCount(input.errors.length - 1) : ""
  showToast({
    variant: "error",
    title: input.title,
    description: message + more,
  })
}

export const loadGlobalConfigQuery = (scope: ServerScope, sdk: OpencodeClient) =>
  queryOptions({
    queryKey: [scope, "config"],
    queryFn: () => retry(() => sdk.global.config.get().then((x) => x.data!)),
  })

export const loadProjectsQuery = (scope: ServerScope, sdk: OpencodeClient) =>
  queryOptions({
    queryKey: [scope, "project"],
    queryFn: () =>
      retry(() =>
        sdk.project.list().then((x) => {
          return (x.data ?? [])
            .filter((p) => !!p?.id)
            .filter((p) => !!p.worktree && !p.worktree.includes("opencode-test"))
            .slice()
            .sort((a, b) => cmp(a.id, b.id))
        }),
      ),
  })

export async function bootstrapGlobal(input: {
  serverSDK: OpencodeClient
  scope: ServerScope
  requestFailedTitle: string
  translate: (key: string, vars?: Record<string, string | number>) => string
  formatMoreCount: (count: number) => string
  setGlobalStore: SetStoreFunction<GlobalStore>
  queryClient: QueryClient
}) {
  const started = Date.now()
  const elapsed = () => Date.now() - started
  const tag = "[bootstrap:global]"
  const timed = <T>(name: string, fn: () => Promise<T>) => () =>
    fn().then((x) => {
      console.log(`${tag} ${name} ${elapsed()}ms`)
      return x
    })
  const slow = [
    timed("config", () => input.queryClient.fetchQuery(loadGlobalConfigQuery(input.scope, input.serverSDK))),
    timed("path", () => input.queryClient.fetchQuery(loadPathQuery(input.scope, null, input.serverSDK))),
    timed("projects", () =>
      input.queryClient
        .fetchQuery(loadProjectsQuery(input.scope, input.serverSDK))
        .then((data) => input.setGlobalStore("project", data)),
    ),
  ]
  await runAll(slow)
  console.log(`${tag} done ${elapsed()}ms`)
  // showErrors({
  //   errors: errors(),
  //   title: input.requestFailedTitle,
  //   translate: input.translate,
  //   formatMoreCount: input.formatMoreCount,
  // })
}

function groupBySession<T extends { id: string; sessionID: string }>(input: T[]) {
  return input.reduce<Record<string, T[]>>((acc, item) => {
    if (!item?.id || !item.sessionID) return acc
    const list = acc[item.sessionID]
    if (list) list.push(item)
    if (!list) acc[item.sessionID] = [item]
    return acc
  }, {})
}

function projectID(directory: string, projects: Project[]) {
  return projects.find((project) => project.worktree === directory || project.sandboxes?.includes(directory))?.id
}

function mergeSession(setStore: SetStoreFunction<State>, session: Session) {
  setStore("session", (list) => {
    const next = list.slice()
    const idx = next.findIndex((item) => item.id >= session.id)
    if (idx === -1) return [...next, session]
    if (next[idx]?.id === session.id) {
      next[idx] = session
      return next
    }
    next.splice(idx, 0, session)
    return next
  })
}

function warmSessions(input: {
  ids: string[]
  store: Store<State>
  setStore: SetStoreFunction<State>
  sdk: OpencodeClient
}) {
  const known = new Set(input.store.session.map((item) => item.id))
  const ids = [...new Set(input.ids)].filter((id) => !!id && !known.has(id))
  if (ids.length === 0) return Promise.resolve()
  return Promise.all(
    ids.map((sessionID) =>
      retry(() => input.sdk.session.get({ sessionID })).then((x) => {
        const session = x.data
        if (!session?.id) return
        mergeSession(input.setStore, session)
      }),
    ),
  ).then(() => undefined)
}

export const loadAgentsQuery = (scope: ServerScope, directory: string | null, sdk: OpencodeClient) =>
  queryOptions({
    queryKey: [scope, directory, "agents"],
    queryFn: () => retry(() => sdk.app.agents().then((x) => normalizeAgentList(x.data))),
  })

export const loadPathQuery = (scope: ServerScope, directory: string | null, sdk: OpencodeClient) =>
  queryOptions<Path>({
    queryKey: [scope, directory, "path"],
    queryFn: () => retry(() => sdk.path.get().then((x) => x.data!)),
  })

export const loadReferencesQuery = (scope: ServerScope, directory: string, sdk: OpencodeClient) =>
  queryOptions<ReferenceInfo[]>({
    queryKey: [scope, directory, "references"] as const,
    queryFn: () => retry(() => sdk.v2.reference.list().then((x) => x.data?.data ?? [])).catch(() => []),
    placeholderData: [],
  })

export function bootstrapDirectory(input: {
  directory: string
  scope: ServerScope
  mcp: boolean
  sdk: OpencodeClient
  store: Store<State>
  setStore: SetStoreFunction<State>
  loadSessions: (directory: string) => Promise<void> | void
  translate: (key: string, vars?: Record<string, string | number>) => string
  global: {
    config: Config
    path: Path
    project: Project[]
  }
  queryClient: QueryClient
  session?: ServerSession
}) {
  // queryKey 必须用规范化后的 key — child-store 的 observers 用规范化 key，
  // 这里若用原始 input.directory，Windows 下 C:/ vs C:\ 会产生不同的 queryKey
  // 导致 TanStack 无法去重，同一个端点被重复请求两次。
  const key = directoryKey(input.directory)
  const loading = input.store.status !== "complete"
  const seededProject = projectID(input.directory, input.global.project)
  const seededPath = input.global.path.directory === input.directory ? input.global.path : undefined
  if (seededProject) input.setStore("project", seededProject)
  if (seededPath) input.setStore("path", seededPath)
  if (Object.keys(input.store.config).length === 0 && Object.keys(input.global.config).length > 0) {
    input.setStore("config", reconcile(input.global.config, { merge: false }))
  }
  if (loading) input.setStore("status", "partial")

  return (async () => {
    const bootStarted = Date.now()
    const elapsed = () => Date.now() - bootStarted
    const tag = `[bootstrap:${getFilename(input.directory)}]`
    // 会话加载优先单独跑，别被 VCS/provider 等慢任务连累（非项目目录如桌面会卡在 vcs.get 超时）。
    const sessionsPromise = Promise.resolve(input.loadSessions(input.directory)).then(() => {
      console.log(`${tag} sessions ${elapsed()}ms`)
    })
    // critical：首屏/侧边栏可见性所必需的最小集合（agents、config、session.status、
    // project/path 回退）。这些失败会导致 status 保持 partial，不进入 complete。
    const critical = [
      () =>
        input.queryClient
          .ensureQueryData(loadAgentsQuery(input.scope, key, input.sdk))
          .then((data) => input.setStore("agent", data)),
      () =>
        retry(() => input.sdk.config.get().then((x) => input.setStore("config", reconcile(x.data!, { merge: false })))),
      () =>
        retry(() =>
          input.sdk.session.status().then(async (x) => {
            if (!input.session) {
              input.setStore("session_status", x.data!)
              return
            }
            const statuses = x.data ?? {}
            input.session.set(
              "session_status",
              produce((draft) => {
                for (const sessionID of Object.keys(draft)) {
                  if (statuses[sessionID]) continue
                  if (input.session?.get(sessionID)?.directory === input.directory) delete draft[sessionID]
                }
              }),
            )
            for (const [sessionID, status] of Object.entries(statuses)) {
              input.session.set("session_status", sessionID, reconcile(status))
            }
            // Warm session info only after seeding statuses so a stalled session
            // fetch cannot park busy indicators behind it, mirroring how live
            // session.status events apply first and resolve info in the background.
            await Promise.all(
              Object.keys(statuses).map((sessionID) => input.session!.resolve(sessionID).catch(() => undefined)),
            )
          }),
        ),
      !seededProject &&
        (() => retry(() => input.sdk.project.current()).then((x) => input.setStore("project", x.data!.id))),
      !seededPath &&
        (() =>
          input.queryClient.ensureQueryData(loadPathQuery(input.scope, key, input.sdk)).then((data) => {
            const next = projectID(data.directory ?? input.directory, input.global.project)
            if (next) input.setStore("project", next)
          })),
    ].filter(Boolean) as (() => Promise<any>)[]

    // deferred：不阻塞首屏标记，错误只走 toast。permission/question/mcp/providers/
    // references/command 列表慢或失败都不该把侧边栏骨架卡住。
    const deferred = [
      input.mcp && (() => retry(() => input.sdk.command.list().then((x) => input.setStore("command", x.data ?? [])))),
      () => input.queryClient.fetchQuery(loadReferencesQuery(input.scope, key, input.sdk)),
      () =>
        retry(() =>
          input.sdk.permission.list().then((x) => {
            const ids = (x.data ?? []).map((perm) => perm?.sessionID).filter((id): id is string => !!id)
            const grouped = groupBySession(
              (x.data ?? []).filter((perm): perm is PermissionRequest => !!perm?.id && !!perm.sessionID),
            )
            const warm = input.session
              ? Promise.all(ids.map((sessionID) => input.session!.resolve(sessionID))).then(() => undefined)
              : warmSessions({ ids, store: input.store, setStore: input.setStore, sdk: input.sdk })
            return warm.then(() =>
              batch(() => {
                const current = input.session?.data.permission ?? input.store.permission
                for (const sessionID of Object.keys(current)) {
                  if (grouped[sessionID]) continue
                  if (input.session?.get(sessionID)?.directory !== input.directory) continue
                  if (input.session) input.session.set("permission", sessionID, [])
                  if (!input.session) input.setStore("permission", sessionID, [])
                }
                for (const [sessionID, permissions] of Object.entries(grouped)) {
                  const value = reconcile(
                    permissions.filter((p) => !!p?.id).sort((a, b) => cmp(a.id, b.id)),
                    { key: "id" },
                  )
                  if (input.session) input.session.set("permission", sessionID, value)
                  if (!input.session) input.setStore("permission", sessionID, value)
                }
              }),
            )
          }),
        ),
      () =>
        retry(() =>
          input.sdk.question.list().then((x) => {
            const ids = (x.data ?? []).map((question) => question?.sessionID).filter((id): id is string => !!id)
            const grouped = groupBySession((x.data ?? []).filter((q): q is QuestionRequest => !!q?.id && !!q.sessionID))
            const warm = input.session
              ? Promise.all(ids.map((sessionID) => input.session!.resolve(sessionID))).then(() => undefined)
              : warmSessions({ ids, store: input.store, setStore: input.setStore, sdk: input.sdk })
            return warm.then(() =>
              batch(() => {
                const current = input.session?.data.question ?? input.store.question
                for (const sessionID of Object.keys(current)) {
                  if (grouped[sessionID]) continue
                  if (input.session?.get(sessionID)?.directory !== input.directory) continue
                  if (input.session) input.session.set("question", sessionID, [])
                  if (!input.session) input.setStore("question", sessionID, [])
                }
                for (const [sessionID, questions] of Object.entries(grouped)) {
                  const value = reconcile(
                    questions.filter((q) => !!q?.id).sort((a, b) => cmp(a.id, b.id)),
                    { key: "id" },
                  )
                  if (input.session) input.session.set("question", sessionID, value)
                  if (!input.session) input.setStore("question", sessionID, value)
                }
              }),
            )
          }),
        ),
      input.mcp && (() => input.queryClient.fetchQuery(loadMcpQuery(input.scope, key, input.sdk))),
      input.mcp && (() => input.queryClient.fetchQuery(loadMcpResourcesQuery(input.scope, key, input.sdk))),
    ].filter(Boolean) as (() => Promise<any>)[]

    await waitForPaint()
    console.log(`${tag} paint ${elapsed()}ms`)
    // critical 与 sessions 同时跑；deferred 并发启动但不 await 其结果，
    // 任一失败只弹 toast，不阻塞 status: "complete" 的判定。
    const criticalErrsPromise = runAll(critical).then((list) => {
      console.log(`${tag} critical ${elapsed()}ms`)
      return errors(list)
    })
    const deferredErrsPromise = runAll(deferred).then((list) => {
      console.log(`${tag} deferred ${elapsed()}ms`)
      return errors(list)
    })
    const [criticalErrs] = await Promise.all([criticalErrsPromise, sessionsPromise.catch(() => undefined)])
    console.log(`${tag} complete ${elapsed()}ms`)
    if (criticalErrs.length > 0) {
      console.error("Failed to finish bootstrap instance", criticalErrs[0])
      const project = getFilename(input.directory)
      showToast({
        variant: "error",
        title: input.translate("toast.project.reloadFailed.title", { project }),
        description: formatServerError(criticalErrs[0], input.translate),
      })
    }

    if (loading && criticalErrs.length === 0) input.setStore("status", "complete")

    // deferred 失败只在后台 toast；若关键路径已成功，这里不重复打扰。
    // 槽位应在 critical 完成后立即释放，让排队目录尽快启动 — deferred 的
    // references/permission/question 不阻塞首屏。
    void deferredErrsPromise.then((errs) => {
      if (errs.length === 0) return
      console.error("Deferred bootstrap tasks failed", errs[0])
      if (criticalErrs.length > 0) return
      const project = getFilename(input.directory)
      showToast({
        variant: "error",
        title: input.translate("toast.project.reloadFailed.title", { project }),
        description: formatServerError(errs[0], input.translate),
      })
    })
  })()
}
