import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { QueryClient } from "@tanstack/solid-query"
import type { Config, OpencodeClient, Project, Session } from "@opencode-ai/sdk/v2/client"
import { bootstrapDirectory, loadPathQuery } from "./bootstrap"
import type { State } from "./types"
import { createServerSession } from "../server-session"
import { ServerScope } from "@/utils/server-scope"

function directoryState() {
  return createStore<State>({
    status: "loading",
    agent: [],
    command: [],
    reference: [],
    project: "",
    projectMeta: undefined,
    icon: undefined,
    config: {},
    path: {
      state: "",
      config: "",
      worktree: "/project",
      directory: "/project",
      home: "/home",
      data: "",
      cache: "",
      log: "",
      database: { path: "", data: "", tables: [] },
    },
    session: [],
    session_status: {},
    session_working(id: string) {
      return this.session_status[id]?.type !== "idle"
    },
    session_diff: {},
    todo: {},
    permission: {},
    question: {},
    mcp_ready: true,
    mcp: {},
    mcp_resource: {},
    message: {},
    part: {},
    part_text_accum_delta: {},
  })
}

describe("bootstrapDirectory", () => {
  test("marks a loading directory partial during bootstrap and complete after success", async () => {
    const mcpReads: string[] = []
    const [store, setStore] = directoryState()

    // bootstrap 是 async — fire-and-forget 才能在 critical 完成前观察到 partial。
    // await 之后 store.status 一定已经走到 complete。
    const boot = bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      mcp: false,
      global: {
        config: {} satisfies Config,
        path: {
          state: "",
          config: "",
          worktree: "/project",
          directory: "/project",
          home: "/home",
          data: "",
          cache: "",
          log: "",
          database: { path: "", data: "", tables: [] },
        },
        project: [{ id: "project", worktree: "/project" } as Project],
      },
      sdk: {
        app: { agents: async () => ({ data: [{ name: "build", mode: "primary" }] }) },
        config: { get: async () => ({ data: {} }) },
        session: { status: async () => ({ data: {} }) },
        command: {
          list: async () => {
            mcpReads.push("command")
            return { data: [] }
          },
        },
        permission: { list: async () => ({ data: [] }) },
        question: { list: async () => ({ data: [] }) },
        v2: { reference: { list: async () => ({ data: { data: [] } }) } },
        mcp: {
          status: async () => {
            mcpReads.push("status")
            return { data: {} }
          },
        },
      } as unknown as OpencodeClient,
      store,
      setStore,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
    })

    expect(store.status).toBe("partial")
    await boot

    expect(store.status).toBe("complete")
    expect(mcpReads).toEqual([])
  })

  test("seeds session status even while warming session info stalls", async () => {
    const [store, setStore] = directoryState()
    // session.get 挂起模拟慢响应 — resolve 的 warming 不该阻塞 status seeding
    // 或 bootstrap 本身。使用可手动 resolve 的 promise，等断言完了再放行。
    const stalled = Promise.withResolvers<{ data?: Session }>()
    const client = {
      app: { agents: async () => ({ data: [{ name: "build", mode: "primary" }] }) },
      config: { get: async () => ({ data: {} }) },
      session: {
        status: async () => ({ data: { ses_busy: { type: "busy" } } }),
        get: () => stalled.promise,
      },
      command: { list: async () => ({ data: [] }) },
      permission: { list: async () => ({ data: [] }) },
      question: { list: async () => ({ data: [] }) },
      v2: { reference: { list: async () => ({ data: { data: [] } }) } },
      mcp: { status: async () => ({ data: {} }) },
    } as unknown as OpencodeClient
    const session = createServerSession(client)
    const stale: Session = {
      id: "ses_stale",
      slug: "ses_stale",
      projectID: "project",
      directory: "/project",
      title: "stale",
      version: "1",
      time: { created: 1, updated: 1 },
    }
    session.remember(stale)
    session.set("session_status", stale.id, { type: "busy" })

    // session.get 挂起时 bootstrap 不会立即 resolve —— warm resolve 挂在 critical 里。
    // 只需等 session_status 被 seeded（也就是说 status handler 的同步部分已跑完），
    // 再手动放行 stalled promise 让 bootstrap 收尾。
    const boot = bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      mcp: false,
      global: {
        config: {} satisfies Config,
        path: {
          state: "",
          config: "",
          worktree: "/project",
          directory: "/project",
          home: "/home",
          data: "",
          cache: "",
          log: "",
          database: { path: "", data: "", tables: [] },
        },
        project: [{ id: "project", worktree: "/project" } as Project],
      },
      sdk: client,
      store,
      setStore,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
      session,
    })

    const deadline = Date.now() + 500
    while (!session.data.session_working("ses_busy") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    expect(session.data.session_status["ses_busy"]?.type).toBe("busy")
    expect(session.data.session_status[stale.id]).toBeUndefined()

    stalled.resolve({ data: undefined })
    await boot
  })
})

describe("query keys", () => {
  test("partitions identical directories by server scope", () => {
    const client = {} as OpencodeClient
    const remote = "https://debian.example" as typeof ServerScope.local

    expect([...loadPathQuery(ServerScope.local, "/repo", client).queryKey]).toEqual(["local", "/repo", "path"])
    expect([...loadPathQuery(remote, "/repo", client).queryKey]).toEqual(["https://debian.example", "/repo", "path"])
  })
})
