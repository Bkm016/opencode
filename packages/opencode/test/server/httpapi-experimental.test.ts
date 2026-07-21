import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { eq } from "drizzle-orm"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { ExperimentalPaths } from "../../src/server/routes/instance/httpapi/groups/experimental"
import { Session } from "@/session/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AccountV2 } from "@opencode-ai/core/account"
import { AccountTable } from "@opencode-ai/core/account/sql"
import { Worktree } from "../../src/worktree"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(Layer.mergeAll(LayerNode.compile(LayerNode.group([Session.node, Database.node])), httpApiLayer))
const testWorktreeMutations = process.platform === "win32" ? it.instance.skip : it.instance

function request(path: string, directory: string, init: RequestInit = {}) {
  return requestInDirectory(path, directory, init)
}

function createSession(input?: Session.CreateInput) {
  return Session.use.create(input)
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((value) => value as T))
}

function waitReady(input: { directory?: string; name?: string }) {
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const on = (event: GlobalEvent) => {
      if (event.payload.type !== Worktree.Event.Ready.type) return
      if (input.directory && event.directory !== input.directory) return
      if (input.name && event.payload.properties.name !== input.name) return
      Deferred.doneUnsafe(ready, Effect.void)
    }

    GlobalBus.on("event", on)
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", on)))

    return yield* Deferred.await(ready).pipe(
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () => Effect.fail(new Error("timed out waiting for worktree.ready")),
      }),
    )
  })
}

function insertAccount() {
  return Effect.acquireRelease(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(AccountTable)
        .values({
          id: AccountV2.ID.make("account-test"),
          email: "test@example.com",
          url: "https://console.example.com",
          access_token: AccountV2.AccessToken.make("access"),
          refresh_token: AccountV2.RefreshToken.make("refresh"),
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .run()
        .pipe(Effect.orDie)
      return "account-test"
    }),
    (id) =>
      Database.Service.use(({ db }) =>
        db
          .delete(AccountTable)
          .where(eq(AccountTable.id, AccountV2.ID.make(id)))
          .run()
          .pipe(Effect.orDie),
      ),
  )
}

function setSessionUpdated(session: Session.Info, updated: number) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(SessionTable)
      .set({ time_updated: updated })
      .where(eq(SessionTable.id, session.id))
      .run()
      .pipe(Effect.orDie)
  })
}

function setSessionTimes(
  sessionID: Session.Info["id"],
  times: { updated?: number; archived?: number | null; projectID?: ProjectV2.ID },
) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(SessionTable)
      .set({
        ...(times.updated !== undefined ? { time_updated: times.updated } : {}),
        ...(times.archived !== undefined ? { time_archived: times.archived } : {}),
        ...(times.projectID !== undefined ? { project_id: times.projectID } : {}),
      })
      .where(eq(SessionTable.id, sessionID))
      .run()
      .pipe(Effect.orDie)
  })
}

function sessionExists(sessionID: Session.Info["id"]) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
    return row !== undefined
  })
}

function insertClosedProject(worktree: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const id = ProjectV2.ID.make("proj_closed_foreign")
    yield* db
      .insert(ProjectTable)
      .values({
        id,
        // 使用与当前打开目录不同的 worktree，避免 openProjectDirectories 映射误命中
        worktree: AbsolutePath.make(worktree),
        vcs: null,
        name: "closed-foreign",
        time_created: Date.now(),
        time_updated: Date.now(),
        sandboxes: [],
      })
      .run()
      .pipe(Effect.orDie)
    return id
  })
}

function withCreatedWorktree(
  directory: string,
  use: (info: Worktree.Info) => Effect.Effect<void, unknown, HttpClient.HttpClient>,
) {
  const name = "api-test"
  const headers = { "content-type": "application/json" }
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const ready = yield* waitReady({ name }).pipe(Effect.forkScoped)
      const created = yield* request(ExperimentalPaths.worktree, directory, {
        method: "POST",
        headers,
        body: JSON.stringify({ name }),
      })

      expect(created.status).toBe(200)
      const info = yield* json<Worktree.Info>(created)
      expect(info).toMatchObject({ name, branch: "opencode/api-test" })
      yield* Fiber.join(ready)
      return info
    }),
    use,
    (info) =>
      Effect.gen(function* () {
        const removed = yield* request(ExperimentalPaths.worktree, directory, {
          method: "DELETE",
          headers,
          body: JSON.stringify({ directory: info.directory }),
        })
        if (removed.status !== 200) return yield* Effect.fail(new Error(`failed to remove worktree: ${removed.status}`))
        const ok = yield* json<boolean>(removed)
        if (!ok) return yield* Effect.fail(new Error(`failed to remove worktree ${info.directory}`))
      }),
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("experimental HttpApi", () => {
  it.instance(
    "serves read-only experimental endpoints through the default server app",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const directory = tmp.directory
        const [consoleState, consoleOrgs, toolList, toolIDs, worktrees, resources] = yield* Effect.all(
          [
            request(ExperimentalPaths.console, directory),
            request(ExperimentalPaths.consoleOrgs, directory),
            request(`${ExperimentalPaths.tool}?provider=opencode&model=gpt-5`, directory),
            request(ExperimentalPaths.toolIDs, directory),
            request(ExperimentalPaths.worktree, directory),
            request(ExperimentalPaths.resource, directory),
          ],
          { concurrency: "unbounded" },
        )

        expect(consoleState.status).toBe(200)
        expect(yield* json(consoleState)).toEqual({
          consoleManagedProviders: [],
          switchableOrgCount: 0,
        })

        expect(consoleOrgs.status).toBe(200)
        expect(yield* json(consoleOrgs)).toEqual({ orgs: [] })

        expect(toolList.status).toBe(200)
        expect(yield* json<unknown[]>(toolList)).toContainEqual(
          expect.objectContaining({
            id: "bash",
            description: expect.any(String),
            parameters: expect.any(Object),
          }),
        )

        expect(toolIDs.status).toBe(200)
        expect(yield* json(toolIDs)).toContain("bash")

        expect(worktrees.status).toBe(200)
        expect(yield* json(worktrees)).toEqual([])

        expect(resources.status).toBe(200)
        expect(yield* json(resources)).toEqual({})
      }),
    {
      config: {
        formatter: false,
        lsp: false,
        mcp: {
          demo: {
            type: "local",
            command: ["echo", "demo"],
            enabled: false,
          },
        },
      },
    },
  )

  it.instance("returns declared worktree errors", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const response = yield* request(ExperimentalPaths.worktree, tmp.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })

      expect(response.status).toBe(400)
      expect(yield* json(response)).toEqual({
        name: "WorktreeNotGitError",
        data: { message: "Worktrees are only supported for git projects" },
      })
    }),
  )

  it.instance(
    "serves Console org switch through the default server app",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const accountID = yield* insertAccount()
        const switched = yield* request(ExperimentalPaths.consoleSwitch, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accountID, orgID: "org-test" }),
        })

        expect(switched.status).toBe(200)
        expect(yield* json(switched)).toBe(true)
      }),
    { config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves global session list through the default server app",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const first = yield* createSession({ title: "page-one" })
        const second = yield* createSession({ title: "page-two" })
        yield* setSessionUpdated(first, 1)
        yield* setSessionUpdated(second, 2)

        const page = yield* request(
          `${ExperimentalPaths.session}?${new URLSearchParams({ directory: tmp.directory, limit: "1" })}`,
          tmp.directory,
        )
        expect(page.status).toBe(200)
        expect(page.headers["x-next-cursor"]).toBeTruthy()

        const body = yield* json<Session.GlobalInfo[]>(page)
        expect(body.map((session) => session.id)).toEqual([second.id])
        expect(body[0].project?.id).toBe(second.projectID)

        const next = yield* request(
          `${ExperimentalPaths.session}?${new URLSearchParams({
            directory: tmp.directory,
            limit: "10",
            cursor: body[0].time.updated.toString(),
          })}`,
          tmp.directory,
        )
        expect(next.status).toBe(200)
        expect((yield* json<Session.GlobalInfo[]>(next)).map((session) => session.id)).toContain(first.id)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  testWorktreeMutations(
    "serves worktree mutations through the default server app",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        yield* withCreatedWorktree(tmp.directory, (info) =>
          Effect.gen(function* () {
            const listed = yield* request(ExperimentalPaths.worktree, tmp.directory)
            expect(listed.status).toBe(200)
            expect(yield* json(listed)).toContain(info.directory)

            const reset = yield* request(ExperimentalPaths.worktreeReset, tmp.directory, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ directory: info.directory }),
            })

            expect(reset.status).toBe(200)
            expect(yield* json(reset)).toBe(true)
          }),
        )

        const afterRemove = yield* request(ExperimentalPaths.worktree, tmp.directory)
        expect(afterRemove.status).toBe(200)
        expect(yield* json(afterRemove)).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "storage budget and compact use openProjectDirectories and Session.remove",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const day = 24 * 60 * 60 * 1000
        const old = Date.now() - 10 * day
        const recent = Date.now() - 1 * day

        const closedProjectID = yield* insertClosedProject(`${tmp.directory}-closed`)
        const oldClosed = yield* createSession({ title: "old-closed" })
        const oldOpen = yield* createSession({ title: "old-open" })
        const oldArchivedOpen = yield* createSession({ title: "old-archived-open" })
        const recentArchived = yield* createSession({ title: "recent-archived" })
        const parent = yield* createSession({ title: "parent" })
        const childKeep = yield* createSession({ title: "child-keep", parentID: parent.id })
        const childGone = yield* createSession({ title: "child-gone", parentID: parent.id })

        // 关闭项目 worktree 不在 openProjectDirectories → 规则 A 候选
        yield* setSessionTimes(oldClosed.id, { updated: old, projectID: closedProjectID })
        yield* setSessionTimes(oldOpen.id, { updated: old })
        yield* setSessionTimes(oldArchivedOpen.id, { updated: recent, archived: old })
        yield* setSessionTimes(recentArchived.id, { updated: recent, archived: recent })
        yield* setSessionTimes(parent.id, { updated: old, projectID: closedProjectID })
        yield* setSessionTimes(childKeep.id, { updated: old })
        yield* setSessionTimes(childGone.id, { updated: old, projectID: closedProjectID })

        const openDirs = [tmp.directory]
        const query = new URLSearchParams()
        for (const directory of openDirs) query.append("openProjectDirectories", directory)
        const budgetRes = yield* request(`${ExperimentalPaths.storage}?${query}`, tmp.directory)
        expect(budgetRes.status).toBe(200)
        const budget = yield* json<{
          sessions: {
            retentionDays: number
            unloadedProjects: "available" | "unavailable"
            candidates: number
            blocked: number
          }
        }>(budgetRes)
        expect(budget.sessions.retentionDays).toBe(7)
        expect(budget.sessions.unloadedProjects).toBe("available")
        // oldClosed, oldArchivedOpen, parent, childGone → 4 candidates; parent blocked by childKeep
        expect(budget.sessions.candidates).toBe(4)
        expect(budget.sessions.blocked).toBe(1)

        const emptyBudgetRes = yield* request(ExperimentalPaths.storage, tmp.directory)
        expect(emptyBudgetRes.status).toBe(200)
        const emptyBudget = yield* json<{ sessions: { unloadedProjects: string; candidates: number } }>(emptyBudgetRes)
        expect(emptyBudget.sessions.unloadedProjects).toBe("unavailable")
        // 仅规则 B：oldArchivedOpen
        expect(emptyBudget.sessions.candidates).toBe(1)

        const beforeCount = yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          return (yield* db.select().from(SessionTable).all().pipe(Effect.orDie)).length
        })

        const compactRes = yield* request(ExperimentalPaths.storageCompact, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessions: true,
            openProjectDirectories: openDirs,
          }),
        })
        expect(compactRes.status).toBe(200)
        const compact = yield* json<{ sessionsRemoved?: number }>(compactRes)
        // oldClosed + oldArchivedOpen + childGone = 3
        expect(compact.sessionsRemoved).toBe(3)

        const afterCount = yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          return (yield* db.select().from(SessionTable).all().pipe(Effect.orDie)).length
        })
        expect(beforeCount - afterCount).toBe(3)

        expect(yield* sessionExists(oldClosed.id)).toBe(false)
        expect(yield* sessionExists(oldOpen.id)).toBe(true)
        expect(yield* sessionExists(oldArchivedOpen.id)).toBe(false)
        expect(yield* sessionExists(recentArchived.id)).toBe(true)
        expect(yield* sessionExists(parent.id)).toBe(true)
        expect(yield* sessionExists(childKeep.id)).toBe(true)
        expect(yield* sessionExists(childGone.id)).toBe(false)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
