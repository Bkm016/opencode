export * as Pty from "./pty"

import { makeLocationNode } from "./effect/app-node"
import type { Disp, Proc } from "#pty"
import { Context, Effect, Layer, Schema, Types } from "effect"
import { Pty } from "@opencode-ai/schema/pty"
import { Config } from "./config"
import { EventV2 } from "./event"
import { Location } from "./location"
import { PtyID } from "./pty/schema"
import { Shell } from "./shell"
import { lazy } from "./util/lazy"
import { spawnSync } from "child_process"

const BUFFER_LIMIT = 1024 * 1024 * 2
const KILL_GRACE_MS = 1_500

function descendants(root: number) {
  const result = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" })
  if (result.status !== 0 || !result.stdout) return []
  const children = new Map<number, number[]>()
  for (const line of result.stdout.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (!pid || ppid === undefined || Number.isNaN(ppid)) continue
    children.set(ppid, [...(children.get(ppid) ?? []), pid])
  }
  const found: number[] = []
  const queue = [root]
  while (queue.length) {
    for (const pid of children.get(queue.shift()!) ?? []) {
      found.push(pid)
      queue.push(pid)
    }
  }
  return found
}

function signal(pid: number, name: NodeJS.Signals) {
  try {
    process.kill(pid, name)
  } catch {}
}

// 只发挂断信号停不住忽略 SIGHUP 的进程（开发服务器、nohup 等），也管不到派生出去的子进程：
// 对整个进程组和整棵进程树发 TERM，过一会儿还活着的再 KILL
function terminate(proc: Proc) {
  try {
    proc.kill()
  } catch {}
  if (process.platform === "win32" || !proc.pid) return
  const pids = [proc.pid, ...descendants(proc.pid)]
  signal(-proc.pid, "SIGTERM")
  for (const pid of pids) signal(pid, "SIGTERM")
  setTimeout(() => {
    signal(-proc.pid, "SIGKILL")
    for (const pid of pids) signal(pid, "SIGKILL")
  }, KILL_GRACE_MS).unref()
}
// Exited sessions stay observable (status, exit code, retained output) until removed explicitly.
// Cap retention so abandoned terminals do not accumulate unbounded buffers.
const EXITED_LIMIT = 25
const pty = lazy(() => import("#pty"))

type Subscriber = {
  readonly onData: (chunk: string) => void
  readonly onEnd: (event: { exitCode?: number }) => void
  active: boolean
  detached: boolean
  pending: string[]
  end?: { exitCode?: number }
}

type Active = {
  info: Info
  process: Proc
  buffer: string
  bufferCursor: number
  cursor: number
  subscribers: Map<object, Subscriber>
  listeners: Disp[]
}

export const Info = Pty.Info
export type Info = Types.DeepMutable<typeof Info.Type>

export const CreateInput = Pty.CreateInput

export type CreateInput = Types.DeepMutable<typeof CreateInput.Type>

export const UpdateInput = Pty.UpdateInput

export type UpdateInput = Types.DeepMutable<typeof UpdateInput.Type>

export const Event = Pty.Event

export type AttachInput = {
  // Absolute output cursor to replay from. -1 tails from the current end; omitted replays the full retained buffer.
  readonly cursor?: number
  // Callbacks fire synchronously from the native PTY data path; keep them non-blocking.
  readonly onData: (chunk: string) => void
  // Fired once when the session stops producing output: process exit (exitCode set), removal, or service teardown.
  readonly onEnd: (event: { exitCode?: number }) => void
}

export type Attachment = {
  // Retained output from the requested cursor to the current end.
  readonly replay: string
  // Absolute output cursor after replay.
  readonly cursor: number
  readonly write: (data: string) => void
  // Starts live delivery after the caller has applied replay and cursor metadata.
  readonly activate: () => void
  readonly detach: () => void
}

// 接管一个已在运行的普通子进程（非 PTY），如超时转后台的前台命令；输出与退出由调用方通过 Proc 接口转发。
export type Process = Proc
export type Disposable = Disp

export type AdoptInput = {
  readonly process: Proc
  readonly title: string
  readonly command: string
  readonly args: string[]
  readonly cwd: string
  // 接管前已产生的输出，作为可回放缓冲的开头
  readonly replay?: string
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Pty.NotFoundError", {
  ptyID: PtyID,
}) {}

export class ExitedError extends Schema.TaggedErrorClass<ExitedError>()("Pty.ExitedError", {
  ptyID: PtyID,
}) {}

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
  readonly get: (id: PtyID) => Effect.Effect<Info, NotFoundError>
  readonly create: (input: CreateInput) => Effect.Effect<Info>
  readonly adopt: (input: AdoptInput) => Effect.Effect<Info>
  readonly update: (id: PtyID, input: UpdateInput) => Effect.Effect<Info, NotFoundError>
  readonly remove: (id: PtyID) => Effect.Effect<void, NotFoundError>
  readonly write: (id: PtyID, data: string) => Effect.Effect<void, NotFoundError>
  readonly attach: (id: PtyID, input: AttachInput) => Effect.Effect<Attachment, NotFoundError | ExitedError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Pty") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const location = yield* Location.Service
    const config = yield* Config.Service
    const context = yield* Effect.context()
    const runFork = Effect.runForkWith(context)
    const sessions = new Map<PtyID, Active>()
    const exitOrder: PtyID[] = []

    function notifyEnd(session: Active, event: { exitCode?: number }) {
      for (const subscriber of session.subscribers.values()) {
        if (!subscriber.active) {
          subscriber.end = event
          continue
        }
        try {
          subscriber.onEnd(event)
        } catch {}
      }
      session.subscribers.clear()
    }

    function teardown(session: Active) {
      for (const listener of session.listeners) listener.dispose()
      session.listeners.length = 0
      if (session.info.status === "running") {
        terminate(session.process)
      }
      notifyEnd(session, {})
    }

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const session of sessions.values()) teardown(session)
        sessions.clear()
        exitOrder.length = 0
      }),
    )

    const requireSession = Effect.fn("Pty.requireSession")(function* (id: PtyID) {
      const session = sessions.get(id)
      if (!session) return yield* new NotFoundError({ ptyID: id })
      return session
    })

    const removeSession = Effect.fnUntraced(function* (id: PtyID) {
      const session = sessions.get(id)
      if (!session) return
      sessions.delete(id)
      const index = exitOrder.indexOf(id)
      if (index !== -1) exitOrder.splice(index, 1)
      yield* Effect.logInfo("removing session", { id })
      teardown(session)
      yield* events.publish(Event.Deleted, { id: session.info.id })
    })

    const remove = Effect.fn("Pty.remove")(function* (id: PtyID) {
      yield* requireSession(id)
      yield* removeSession(id)
    })

    const list = Effect.fn("Pty.list")(function* () {
      return Array.from(sessions.values()).map((session) => session.info)
    })

    const get = Effect.fn("Pty.get")(function* (id: PtyID) {
      return (yield* requireSession(id)).info
    })

    const create = Effect.fn("Pty.create")(function* (input: CreateInput) {
      const id = PtyID.ascending()
      const command = input.command || Shell.preferred(Config.latest(yield* config.entries(), "shell"))
      const args = Shell.login(command) ? [...(input.args ?? []), "-l"] : [...(input.args ?? [])]
      const cwd = input.cwd || location.directory
      const env = {
        ...process.env,
        ...input.env,
        TERM: "xterm-256color",
        OPENCODE_TERMINAL: "1",
      } as Record<string, string>
      if (process.platform === "win32") {
        env.LC_ALL = "C.UTF-8"
        env.LC_CTYPE = "C.UTF-8"
        env.LANG = "C.UTF-8"
      }
      yield* Effect.logInfo("creating session", { id, cmd: command, args, cwd })
      const { spawn } = yield* Effect.promise(() => pty())
      const proc = yield* Effect.sync(() => spawn(command, args, { name: "xterm-256color", cwd, env }))
      if (input.initialInput !== undefined) {
        // 在 PTY 建立后注入输入，复用用户配置的 shell，避免把整行脚本误当成可执行文件路径。
        proc.write(input.initialInput + "\r")
      }
      return yield* register(id, proc, {
        id,
        title: input.title || `Terminal ${id.slice(-4)}`,
        command,
        args,
        cwd,
        status: "running",
        pid: proc.pid,
      })
    })

    const adopt = Effect.fn("Pty.adopt")(function* (input: AdoptInput) {
      const id = PtyID.ascending()
      yield* Effect.logInfo("adopting process", { id, pid: input.process.pid, cwd: input.cwd })
      return yield* register(
        id,
        input.process,
        {
          id,
          title: input.title,
          command: input.command,
          args: [...input.args],
          cwd: input.cwd,
          status: "running",
          pid: input.process.pid,
        },
        input.replay,
      )
    })

    const register = Effect.fnUntraced(function* (id: PtyID, proc: Proc, info: Info, replay = "") {
      const session: Active = {
        info,
        process: proc,
        buffer: replay.slice(-BUFFER_LIMIT),
        bufferCursor: Math.max(0, replay.length - BUFFER_LIMIT),
        cursor: replay.length,
        subscribers: new Map(),
        listeners: [],
      }
      sessions.set(id, session)
      session.listeners.push(
        proc.onData((chunk) => {
          session.cursor += chunk.length
          for (const [token, subscriber] of session.subscribers.entries()) {
            if (!subscriber.active) {
              subscriber.pending.push(chunk)
              continue
            }
            try {
              subscriber.onData(chunk)
            } catch {
              session.subscribers.delete(token)
            }
          }
          session.buffer += chunk
          if (session.buffer.length <= BUFFER_LIMIT) return
          const excess = session.buffer.length - BUFFER_LIMIT
          session.buffer = session.buffer.slice(excess)
          session.bufferCursor += excess
        }),
        proc.onExit(({ exitCode }) => {
          if (session.info.status === "exited") return
          session.info.status = "exited"
          session.info.exitCode = exitCode
          notifyEnd(session, { exitCode })
          exitOrder.push(id)
          runFork(
            Effect.gen(function* () {
              yield* Effect.logInfo("session exited", { id, exitCode })
              yield* events.publish(Event.Exited, { id, exitCode })
              while (exitOrder.length > EXITED_LIMIT) {
                const oldest = exitOrder[0]
                if (!oldest) break
                yield* removeSession(oldest)
              }
            }),
          )
        }),
      )
      yield* events.publish(Event.Created, { info })
      return info
    })

    const update = Effect.fn("Pty.update")(function* (id: PtyID, input: UpdateInput) {
      const session = yield* requireSession(id)
      if (input.title) session.info.title = input.title
      if (input.size && session.info.status === "running") session.process.resize(input.size.cols, input.size.rows)
      yield* events.publish(Event.Updated, { info: session.info })
      return session.info
    })

    const write = Effect.fn("Pty.write")(function* (id: PtyID, data: string) {
      const session = yield* requireSession(id)
      if (session.info.status === "running") session.process.write(data)
    })

    const attach = Effect.fn("Pty.attach")(function* (id: PtyID, input: AttachInput) {
      const session = yield* requireSession(id)
      if (session.info.status !== "running") return yield* new ExitedError({ ptyID: id })
      yield* Effect.logInfo("client attached to session", { id, directory: location.directory })
      const token = {}
      const subscriber: Subscriber = {
        onData: input.onData,
        onEnd: input.onEnd,
        active: false,
        detached: false,
        pending: [],
      }
      session.subscribers.set(token, subscriber)
      const start = session.bufferCursor
      const end = session.cursor
      const from =
        input.cursor === -1
          ? end
          : typeof input.cursor === "number" && Number.isSafeInteger(input.cursor)
            ? Math.max(0, input.cursor)
            : 0
      const replay = (() => {
        if (!session.buffer || from >= end) return ""
        const offset = Math.max(0, from - start)
        if (offset >= session.buffer.length) return ""
        return session.buffer.slice(offset)
      })()
      return {
        replay,
        cursor: end,
        write: (data: string) => {
          if (session.info.status === "running") session.process.write(data)
        },
        activate: () => {
          if (subscriber.active || subscriber.detached) return
          subscriber.active = true
          try {
            for (const chunk of subscriber.pending) subscriber.onData(chunk)
            subscriber.pending.length = 0
            if (subscriber.end) subscriber.onEnd(subscriber.end)
          } catch {
            session.subscribers.delete(token)
          }
        },
        detach: () => {
          subscriber.detached = true
          subscriber.pending.length = 0
          subscriber.end = undefined
          session.subscribers.delete(token)
        },
      }
    })

    return Service.of({ list, get, create, adopt, update, remove, write, attach })
  }),
)

export const locationLayer = layer.pipe(Layer.provide(Config.locationLayer))

export const node = makeLocationNode({ service: Service, layer, deps: [EventV2.node, Location.node, Config.node] })
