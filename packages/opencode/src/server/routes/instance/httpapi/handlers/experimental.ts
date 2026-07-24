import { Account } from "@/account/account"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { Project } from "@/project/project"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Worktree } from "@/worktree"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { ProviderRequestDump } from "@opencode-ai/llm"
import { inArray, sql } from "drizzle-orm"
import { Effect, Option } from "effect"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import fs from "fs/promises"
import path from "path"
import { InstanceHttpApi } from "../api"
import { notFound } from "../errors"
import {
  ConsoleSwitchPayload,
  SessionListQuery,
  StorageBudgetQuery,
  StorageCompactPayload,
  ToolListQuery,
  WorktreeApiError,
} from "../groups/experimental"
import { planSessionCleanup, SESSION_RETENTION_DAYS } from "./storage-session-cleanup"

function mapWorktreeError<A, R>(self: Effect.Effect<A, Worktree.Error, R>) {
  return self.pipe(
    Effect.mapError((error) => new WorktreeApiError({ name: error._tag, data: { message: error.message } })),
  )
}

const DEFAULT_RETENTION_DAYS = 7

async function fileSize(target: string) {
  return fs.stat(target).then(
    (stat) => stat.size,
    () => undefined,
  )
}

async function treeBytes(root: string) {
  let bytes = 0
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()!
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      const stat = await fs.stat(full).catch(() => undefined)
      if (!stat) continue
      bytes += stat.size
    }
  }
  return bytes
}

async function dataRootBreakdown(root: string) {
  const listing = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  const entries = await Promise.all(
    listing.map(async (entry) => {
      const full = path.join(root, entry.name)
      if (entry.isDirectory()) {
        return {
          name: entry.name,
          path: full,
          kind: "directory" as const,
          bytes: await treeBytes(full),
        }
      }
      if (!entry.isFile()) return undefined
      const size = await fileSize(full)
      return {
        name: entry.name,
        path: full,
        kind: "file" as const,
        bytes: size ?? 0,
      }
    }),
  )
  return entries
    .flatMap((entry) => (entry ? [entry] : []))
    .sort((a, b) => b.bytes - a.bytes)
}

async function directoryStats(root: string, input: { retentionDays: number; prefix?: string }) {
  const cutoff = Date.now() - input.retentionDays * 24 * 60 * 60 * 1000
  let bytes = 0
  let files = 0
  let expiredBytes = 0
  let expiredFiles = 0
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()!
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      if (input.prefix && !entry.name.startsWith(input.prefix)) continue
      const stat = await fs.stat(full).catch(() => undefined)
      if (!stat) continue
      files += 1
      bytes += stat.size
      if (stat.mtimeMs < cutoff) {
        expiredFiles += 1
        expiredBytes += stat.size
      }
    }
  }
  return { path: root, bytes, files, expiredBytes, expiredFiles }
}

async function removeExpiredFiles(root: string, input: { retentionDays: number; prefix?: string }) {
  const cutoff = Date.now() - input.retentionDays * 24 * 60 * 60 * 1000
  let removed = 0
  let bytes = 0
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()!
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      if (input.prefix && !entry.name.startsWith(input.prefix)) continue
      const stat = await fs.stat(full).catch(() => undefined)
      if (!stat || stat.mtimeMs >= cutoff) continue
      await fs.unlink(full).catch(() => undefined)
      removed += 1
      bytes += stat.size
    }
  }
  return { removed, bytes }
}

export const experimentalHandlers = HttpApiBuilder.group(InstanceHttpApi, "experimental", (handlers) =>
  Effect.gen(function* () {
    const account = yield* Account.Service
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const project = yield* Project.Service
    const registry = yield* ToolRegistry.Service
    const worktreeSvc = yield* Worktree.Service
    const sessions = yield* Session.Service
    const sessionPrompt = yield* SessionPrompt.Service
    const background = yield* BackgroundJob.Service
    const flags = yield* RuntimeFlags.Service
    const { db } = yield* Database.Service

    // App 传入 worktree 目录 → ProjectTable.worktree 映射 project id；空/缺失则规则 A unavailable。
    const openProjectIDs = Effect.fn("ExperimentalHttpApi.openProjectIDs")(function* (
      directories: readonly string[] | undefined,
    ) {
      if (!directories || directories.length === 0) return new Set<string>()
      const resolved = [...new Set(directories.map((directory) => FSUtil.resolve(directory)))]
      const rows = yield* db
        .select({ id: ProjectTable.id, worktree: ProjectTable.worktree })
        .from(ProjectTable)
        .all()
        .pipe(Effect.orDie)
      const open = new Set(resolved)
      return new Set(rows.filter((row) => open.has(FSUtil.resolve(row.worktree))).map((row) => row.id))
    })

    const sessionCleanupPlan = Effect.fn("ExperimentalHttpApi.sessionCleanupPlan")(function* (input: {
      cutoff: number
      openProjectDirectories?: readonly string[]
    }) {
      const rows = yield* db
        .select({
          id: SessionTable.id,
          project_id: SessionTable.project_id,
          parent_id: SessionTable.parent_id,
          time_updated: SessionTable.time_updated,
          time_archived: SessionTable.time_archived,
        })
        .from(SessionTable)
        .all()
        .pipe(Effect.orDie)
      const openIDs = yield* openProjectIDs(input.openProjectDirectories)
      return planSessionCleanup({
        rows,
        openProjectIDs: openIDs,
        cutoff: input.cutoff,
      })
    })

    const capabilities = Effect.fn("ExperimentalHttpApi.capabilities")(function* () {
      return { backgroundSubagents: flags.experimentalBackgroundSubagents }
    })

    const getConsole = Effect.fn("ExperimentalHttpApi.console")(function* () {
      const [state, groups] = yield* Effect.all(
        [
          config.getConsoleState(),
          account.orgsByAccount().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
        ],
        {
          concurrency: "unbounded",
        },
      )
      return {
        consoleManagedProviders: state.consoleManagedProviders,
        ...(state.activeOrgName ? { activeOrgName: state.activeOrgName } : {}),
        switchableOrgCount: groups.reduce((count, group) => count + group.orgs.length, 0),
      }
    })

    const listConsoleOrgs = Effect.fn("ExperimentalHttpApi.consoleOrgs")(function* () {
      const [groups, active] = yield* Effect.all(
        [
          account.orgsByAccount().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
          account.active().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
        ],
        {
          concurrency: "unbounded",
        },
      )
      const info = Option.getOrUndefined(active)
      return {
        orgs: groups.flatMap((group) =>
          group.orgs.map((org) => ({
            accountID: group.account.id,
            accountEmail: group.account.email,
            accountUrl: group.account.url,
            orgID: org.id,
            orgName: org.name,
            active: !!info && info.id === group.account.id && info.active_org_id === org.id,
          })),
        ),
      }
    })

    const switchConsole = Effect.fn("ExperimentalHttpApi.consoleSwitch")(function* (ctx: {
      payload: typeof ConsoleSwitchPayload.Type
    }) {
      yield* account
        .use(ctx.payload.accountID, Option.some(ctx.payload.orgID))
        .pipe(Effect.catch(() => Effect.fail(new HttpApiError.BadRequest({}))))
      return true
    })

    const tool = Effect.fn("ExperimentalHttpApi.tool")(function* (ctx: { query: typeof ToolListQuery.Type }) {
      const list = yield* registry.tools({
        providerID: ctx.query.provider,
        modelID: ctx.query.model,
        agent: yield* agents.defaultInfo(),
      })
      return list.map((item) => ({
        id: item.id,
        description: item.description,
        parameters: ToolJsonSchema.fromTool(item),
        ...(item.nameAliases?.length ? { nameAliases: [...item.nameAliases] } : {}),
        ...(item.inputAliases ? { inputAliases: { ...item.inputAliases } } : {}),
      }))
    })

    const toolIDs = Effect.fn("ExperimentalHttpApi.toolIDs")(function* () {
      return yield* registry.ids()
    })

    const worktree = Effect.fn("ExperimentalHttpApi.worktree")(function* () {
      const ctx = yield* InstanceState.context
      return yield* project.sandboxes(ctx.project.id)
    })

    const worktreeCreate = Effect.fn("ExperimentalHttpApi.worktreeCreate")(function* (ctx: {
      payload: typeof Worktree.CreateInput.Type | void
    }) {
      return yield* mapWorktreeError(worktreeSvc.create(ctx.payload ?? undefined))
    })

    const worktreeRemove = Effect.fn("ExperimentalHttpApi.worktreeRemove")(function* (input: {
      payload: Worktree.RemoveInput
    }) {
      const ctx = yield* InstanceState.context
      yield* mapWorktreeError(worktreeSvc.remove(input.payload))
      yield* project.removeSandbox(ctx.project.id, input.payload.directory)
      return true
    })

    const worktreeReset = Effect.fn("ExperimentalHttpApi.worktreeReset")(function* (ctx: {
      payload: Worktree.ResetInput
    }) {
      yield* mapWorktreeError(worktreeSvc.reset(ctx.payload))
      return true
    })

    const session = Effect.fn("ExperimentalHttpApi.session")(function* (ctx: { query: typeof SessionListQuery.Type }) {
      const limit = ctx.query.limit ?? 100
      const directory = ctx.query.directory ? yield* InstanceState.directory : undefined
      const all = yield* sessions.listGlobal({
        directory,
        roots: ctx.query.roots,
        start: ctx.query.start,
        cursor: ctx.query.cursor,
        search: ctx.query.search,
        limit: limit + 1,
        archived: ctx.query.archived,
      })
      const list = all.length > limit ? all.slice(0, limit) : all
      return HttpServerResponse.jsonUnsafe(list, {
        headers:
          all.length > limit && list.length > 0
            ? { "x-next-cursor": String(list[list.length - 1].time.updated) }
            : undefined,
      })
    })

    const sessionBackground = Effect.fn("ExperimentalHttpApi.sessionBackground")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      if (!flags.experimentalBackgroundSubagents) return false
      const jobs = (yield* background.list()).filter(
        (job) =>
          job.type === "task" &&
          job.status === "running" &&
          job.metadata?.parentSessionId === ctx.params.sessionID &&
          job.metadata.background !== true,
      )
      const promoted = yield* Effect.forEach(jobs, (job) => background.promote(job.id), { concurrency: "unbounded" })
      return promoted.some((job) => job !== undefined)
    })

    const sessionSystemPrompt = Effect.fn("ExperimentalHttpApi.sessionSystemPrompt")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      return yield* sessionPrompt
        .systemPrompt(ctx.params.sessionID)
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
    })

    const sessionProviderRequest = Effect.fn("ExperimentalHttpApi.sessionProviderRequest")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      const snapshot = ProviderRequestDump.get(ctx.params.sessionID)
      if (!snapshot) {
        return yield* notFound(`No provider request captured for session: ${ctx.params.sessionID}`)
      }
      // body 是完整 wire JSON，可能极大且含深层结构；跳过 Schema 编解码，直接 stringify。
      return HttpServerResponse.jsonUnsafe(snapshot)
    })

    const resource = Effect.fn("ExperimentalHttpApi.resource")(function* () {
      return yield* mcp.resources()
    })

    const storageBudget = Effect.fn("ExperimentalHttpApi.storage")(function* (input?: {
      retentionDays?: number
      openProjectDirectories?: readonly string[]
      // 与 compact 同一次请求共用 cutoff，便于 before/after 对比
      cutoff?: number
    }) {
      const days =
        input?.retentionDays !== undefined && Number.isFinite(input.retentionDays) && input.retentionDays > 0
          ? input.retentionDays
          : DEFAULT_RETENTION_DAYS
      const cutoff = input?.cutoff ?? Date.now() - SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000
      const dbPath = Database.path()
      const dataRoot = Global.Path.data
      const [size, walSize, shmSize, entries] = yield* Effect.promise(() =>
        Promise.all([
          fileSize(dbPath),
          fileSize(`${dbPath}-wal`),
          fileSize(`${dbPath}-shm`),
          dataRootBreakdown(dataRoot),
        ]),
      )
      const pageCount = yield* db.get<{ page_count: number }>(sql`PRAGMA page_count`).pipe(
        Effect.map((row) => row?.page_count),
        Effect.catch(() => Effect.succeed(undefined)),
      )
      const pageSize = yield* db.get<{ page_size: number }>(sql`PRAGMA page_size`).pipe(
        Effect.map((row) => row?.page_size),
        Effect.catch(() => Effect.succeed(undefined)),
      )
      const freelistCount = yield* db.get<{ freelist_count: number }>(sql`PRAGMA freelist_count`).pipe(
        Effect.map((row) => row?.freelist_count),
        Effect.catch(() => Effect.succeed(undefined)),
      )
      const reclaimableBytes =
        pageSize !== undefined && freelistCount !== undefined ? pageSize * freelistCount : undefined
      const tableNames = yield* db
        .all<{ name: string }>(
          sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
        )
        .pipe(Effect.catch(() => Effect.succeed([] as { name: string }[])))
      const tables = yield* Effect.forEach(
        tableNames,
        (table) =>
          Effect.gen(function* () {
            const count = yield* db
              .get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM ${sql.identifier(table.name)}`)
              .pipe(
                Effect.map((row) => row?.count),
                Effect.catch(() => Effect.succeed(undefined)),
              )
            return { name: table.name, rows: count }
          }),
        { concurrency: 1 },
      )
      const toolOutput = yield* Effect.promise(() =>
        directoryStats(path.join(dataRoot, ToolOutputStore.MANAGED_DIRECTORY), {
          retentionDays: days,
          prefix: "tool_",
        }),
      )
      const logs = yield* Effect.promise(() => directoryStats(Global.Path.log, { retentionDays: days }))
      const plan = yield* sessionCleanupPlan({
        cutoff,
        openProjectDirectories: input?.openProjectDirectories,
      })
      const dataBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0)
      return {
        database: {
          path: dbPath,
          size,
          walSize,
          shmSize,
          pageCount,
          pageSize,
          freelistCount,
          reclaimableBytes,
        },
        toolOutput,
        logs,
        sessions: {
          retentionDays: plan.retentionDays,
          unloadedProjects: plan.unloadedProjects,
          candidates: plan.candidates,
          blocked: plan.blocked,
        },
        retentionDays: days,
        dataRoot,
        dataBytes,
        entries,
        tables: tables.sort((a, b) => (b.rows ?? 0) - (a.rows ?? 0)),
      }
    })

    const storageGet = Effect.fn("ExperimentalHttpApi.storageGet")(function* (ctx: {
      query: typeof StorageBudgetQuery.Type
    }) {
      return yield* storageBudget({
        openProjectDirectories: ctx.query.openProjectDirectories,
      })
    })

    const storageCompact = Effect.fn("ExperimentalHttpApi.storageCompact")(function* (ctx: {
      payload: typeof StorageCompactPayload.Type
    }) {
      const payload = ctx.payload
      const actions = {
        checkpoint: payload.checkpoint === true,
        vacuum: payload.vacuum === true,
        toolOutput: payload.toolOutput === true,
        logs: payload.logs === true,
        sessions: payload.sessions === true,
      }
      if (!actions.checkpoint && !actions.vacuum && !actions.toolOutput && !actions.logs && !actions.sessions) {
        return yield* Effect.fail(new HttpApiError.BadRequest({}))
      }
      const retentionDays =
        payload.retentionDays !== undefined && Number.isFinite(payload.retentionDays) && payload.retentionDays > 0
          ? payload.retentionDays
          : DEFAULT_RETENTION_DAYS
      // 单次 POST 冻结 started/cutoff；before 与执行计划共用同一 cutoff
      const started = Date.now()
      const cutoff = started - SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000
      const openProjectDirectories = payload.openProjectDirectories
      const before = yield* storageBudget({
        retentionDays,
        openProjectDirectories,
        cutoff,
      })
      let checkpoint: boolean | undefined
      let vacuum: boolean | undefined
      let toolOutputRemoved: number | undefined
      let toolOutputBytes: number | undefined
      let logsRemoved: number | undefined
      let logsBytes: number | undefined
      let sessionsRemoved: number | undefined

      // 会话删除必须在 checkpoint/VACUUM 之前，使 freelist 反映删除结果
      if (actions.sessions) {
        const plan = yield* sessionCleanupPlan({
          cutoff,
          openProjectDirectories,
        })
        for (const root of plan.roots) {
          yield* sessions.remove(SessionID.make(root)).pipe(Effect.catch(() => Effect.void))
        }
        // 以库内实际消失数量为准，避免 Session.remove 吞错导致虚报
        if (plan.removableIDs.length === 0) {
          sessionsRemoved = 0
        } else {
          const remaining = yield* db
            .select({ id: SessionTable.id })
            .from(SessionTable)
            .where(inArray(SessionTable.id, plan.removableIDs.map((id) => SessionID.make(id))))
            .all()
            .pipe(Effect.orDie)
          sessionsRemoved = plan.removableIDs.length - remaining.length
        }
      }
      if (actions.checkpoint || actions.vacuum) {
        yield* db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`).pipe(Effect.catch(() => Effect.void))
        checkpoint = true
      }
      if (actions.vacuum) {
        const vacuumed = yield* db.run(sql`VACUUM`).pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        )
        if (!vacuumed) return yield* Effect.fail(new HttpApiError.BadRequest({}))
        vacuum = true
      }
      if (actions.toolOutput) {
        const result = yield* Effect.promise(() =>
          removeExpiredFiles(path.join(Global.Path.data, ToolOutputStore.MANAGED_DIRECTORY), {
            retentionDays,
            prefix: "tool_",
          }),
        )
        toolOutputRemoved = result.removed
        toolOutputBytes = result.bytes
      }
      if (actions.logs) {
        const result = yield* Effect.promise(() => removeExpiredFiles(Global.Path.log, { retentionDays }))
        logsRemoved = result.removed
        logsBytes = result.bytes
      }

      const after = yield* storageBudget({
        retentionDays,
        openProjectDirectories,
        cutoff,
      })
      return {
        ...(checkpoint !== undefined ? { checkpoint } : {}),
        ...(vacuum !== undefined ? { vacuum } : {}),
        ...(toolOutputRemoved !== undefined ? { toolOutputRemoved, toolOutputBytes } : {}),
        ...(logsRemoved !== undefined ? { logsRemoved, logsBytes } : {}),
        ...(sessionsRemoved !== undefined ? { sessionsRemoved } : {}),
        before,
        after,
        durationMs: Date.now() - started,
      }
    })

    return handlers
      .handle("capabilities", capabilities)
      .handle("console", getConsole)
      .handle("consoleOrgs", listConsoleOrgs)
      .handle("consoleSwitch", switchConsole)
      .handle("tool", tool)
      .handle("toolIDs", toolIDs)
      .handle("worktree", worktree)
      .handle("worktreeCreate", worktreeCreate)
      .handle("worktreeRemove", worktreeRemove)
      .handle("worktreeReset", worktreeReset)
      .handle("session", session)
      .handle("sessionBackground", sessionBackground)
      .handle("sessionSystemPrompt", sessionSystemPrompt)
      .handle("sessionProviderRequest", sessionProviderRequest)
      .handle("resource", resource)
      .handle("storage", storageGet)
      .handle("storageCompact", storageCompact)
  }),
)
