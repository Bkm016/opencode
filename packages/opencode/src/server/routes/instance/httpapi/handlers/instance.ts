import { Agent } from "@/agent/agent"
import { Command } from "@/command"
import { Config } from "@/config/config"
import * as InstanceState from "@/effect/instance-state"
import type { InstanceContext } from "@/project/instance-context"
import { Format } from "@/format"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { LSP } from "@/lsp/lsp"
import { Vcs } from "@/project/vcs"
import { Skill } from "@/skill"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { AbsolutePath } from "@opencode-ai/core/schema"
import fs from "fs/promises"
import path from "path"
import { InstanceHttpApi } from "../api"
import { ApiVcsApplyError } from "../groups/instance"
import { markInstanceForDisposal, markInstanceForReload } from "../lifecycle"
import { Location } from "@opencode-ai/schema/location"

function runFilePath(ctx: InstanceContext) {
  const directory = ctx.project.vcs ? ctx.worktree : ctx.directory
  return path.join(directory, ".opencode", "run.json")
}

function runFileResponse(ctx: InstanceContext, filepath: string, scripts: Record<string, string>) {
  return {
    location: new Location.Info({
      directory: AbsolutePath.make(ctx.directory),
      project: { id: ctx.project.id, directory: AbsolutePath.make(ctx.worktree) },
    }),
    data: { path: AbsolutePath.make(filepath), scripts },
  }
}

// Count every user table so the Database settings page can show what fills the SQLite file.

async function fileSize(path: string) {
  return fs.stat(path).then(
    (stat) => stat.size,
    () => undefined,
  )
}

export const instanceHandlers = HttpApiBuilder.group(InstanceHttpApi, "instance", (handlers) =>
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const command = yield* Command.Service
    const config = yield* Config.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const skill = yield* Skill.Service
    const vcs = yield* Vcs.Service
    const { db } = yield* Database.Service

    const dispose = Effect.fn("InstanceHttpApi.dispose")(function* () {
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return true
    })

    const reload = Effect.fn("InstanceHttpApi.reload")(function* () {
      const ctx = yield* InstanceState.context
      yield* config.invalidate()
      yield* markInstanceForReload(ctx, {
        directory: ctx.directory,
        worktree: ctx.worktree,
        project: ctx.project,
      })
      return true
    })

    const getPath = Effect.fn("InstanceHttpApi.path")(function* () {
      const ctx = yield* InstanceState.context
      const dbPath = Database.path()
      const [size, walSize, shmSize] = yield* Effect.promise(() =>
        Promise.all([fileSize(dbPath), fileSize(`${dbPath}-wal`), fileSize(`${dbPath}-shm`)]),
      )
      const journalMode = yield* db.get<{ journal_mode: string }>(sql`PRAGMA journal_mode`).pipe(
        Effect.map((row) => row?.journal_mode),
        Effect.catch(() => Effect.succeed(undefined)),
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
      ).pipe(Effect.map((rows) => rows.sort((a, b) => (b.rows ?? 0) - (a.rows ?? 0))))
      return {
        home: Global.Path.home,
        state: Global.Path.state,
        config: Global.Path.config,
        worktree: ctx.worktree,
        directory: ctx.directory,
        data: Global.Path.data,
        cache: Global.Path.cache,
        log: Global.Path.log,
        database: {
          path: dbPath,
          data: Global.Path.data,
          size,
          walSize,
          shmSize,
          journalMode,
          pageCount,
          pageSize,
          freelistCount,
          tables,
        },
      }
    })

    const getVcs = Effect.fn("InstanceHttpApi.vcs")(function* () {
      const [branch, default_branch] = yield* Effect.all([vcs.branch(), vcs.defaultBranch()], {
        concurrency: "unbounded",
      })
      return { branch, default_branch }
    })

    const getVcsStatus = Effect.fn("InstanceHttpApi.vcsStatus")(function* () {
      return yield* vcs.status()
    })

    const getVcsDiffRaw = Effect.fn("InstanceHttpApi.vcsDiffRaw")(function* () {
      return yield* vcs.diffRaw()
    })

    const applyVcs = Effect.fn("InstanceHttpApi.vcsApply")(function* (ctx: { payload: Vcs.ApplyInput }) {
      return yield* vcs.apply(ctx.payload).pipe(
        Effect.mapError(
          (error) =>
            new ApiVcsApplyError({
              name: "VcsApplyError",
              data: {
                message: error.message,
                reason: error.reason,
              },
            }),
        ),
      )
    })

    const getCommand = Effect.fn("InstanceHttpApi.command")(function* () {
      yield* command.reload
      return yield* command.list()
    })

    const getRunFile = Effect.fn("InstanceHttpApi.commandGetRun")(function* () {
      const ctx = yield* InstanceState.context
      const filepath = runFilePath(ctx)
      const value = yield* Effect.promise(() => fs.readFile(filepath, "utf8")).pipe(
        Effect.map((content) => JSON.parse(content) as unknown),
        Effect.catch(() => Effect.succeed(undefined)),
      )
      const scripts =
        typeof value === "object" && value !== null && !Array.isArray(value) && "scripts" in value
          ? value.scripts
          : value
      console.info(`[run] resolved path: ${filepath}`)
      return runFileResponse(
        ctx,
        filepath,
        typeof scripts === "object" && scripts !== null && !Array.isArray(scripts)
          ? Object.fromEntries(Object.entries(scripts).filter(([, template]) => typeof template === "string"))
          : {},
      )
    })

    const updateRun = Effect.fn("InstanceHttpApi.commandUpdateRun")(function* (input: {
      payload: { scripts: Record<string, string> }
    }) {
      const ctx = yield* InstanceState.context
      const filepath = runFilePath(ctx)
      console.info(`[run] saving path: ${filepath}`)
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(filepath), { recursive: true })
        await fs.writeFile(filepath, JSON.stringify(input.payload, null, 2) + "\n")
        console.info(`[run] saved path: ${filepath}`)
      }).pipe(
        Effect.tapError((cause) => Effect.sync(() => console.error(`[run] save failed: ${filepath}`, cause))),
        Effect.orDie,
      )
      yield* command.reload
      return runFileResponse(ctx, filepath, input.payload.scripts)
    })

    const getAgent = Effect.fn("InstanceHttpApi.agent")(function* () {
      return yield* agent.list()
    })

    const getSkill = Effect.fn("InstanceHttpApi.skill")(function* () {
      return yield* skill.all()
    })

    const getLsp = Effect.fn("InstanceHttpApi.lsp")(function* () {
      return yield* lsp.status()
    })

    const getFormatter = Effect.fn("InstanceHttpApi.formatter")(function* () {
      return yield* format.status()
    })

    return handlers
      .handle("dispose", dispose)
      .handle("reload", reload)
      .handle("path", getPath)
      .handle("vcs", getVcs)
      .handle("vcsStatus", getVcsStatus)
      .handle("vcsDiffRaw", getVcsDiffRaw)
      .handle("vcsApply", applyVcs)
      .handle("command", getCommand)
      .handle("commandGetRun", getRunFile)
      .handle("commandUpdateRun", updateRun)
      .handle("agent", getAgent)
      .handle("skill", getSkill)
      .handle("lsp", getLsp)
      .handle("formatter", getFormatter)
  }),
)
