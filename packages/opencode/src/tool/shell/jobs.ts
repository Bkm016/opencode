import { createWriteStream, type WriteStream } from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "path"
import stripAnsi from "strip-ansi"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { Pty } from "@opencode-ai/core/pty"
import { PtyID } from "@opencode-ai/core/pty/schema"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { Shell } from "@opencode-ai/core/shell"

/**
 * 代理后台 shell 作业注册表。
 * 作业直接跑在 Pty.Service 的 PTY 里：终端面板可按同一个 ptyID attach（“在终端中打开”），
 * 这里另外维护一份去 ANSI 的文本缓冲与模型读取游标。
 */

export const MAX_RUNNING = 8
const TEXT_LIMIT = 2 * 1024 * 1024
// 退出后保留的作业数，超出按结束时间淘汰
const FINISHED_LIMIT = 50
// 输出静默这么久且末行像提示符时，认为进程可能在等输入
const PROMPT_IDLE_MS = 1500

export type Status = "running" | "exited" | "killed"

export type Note = (job: Info, tail: string) => void

export type Info = {
  id: string
  sessionID: string
  command: string
  description?: string
  cwd: string
  pid: number
  status: Status
  exitCode?: number
  startedAt: number
  endedAt?: number
  log: string
}

type Waiter = {
  until?: RegExp
  from: number
  resolve: () => void
}

type Job = {
  info: Info
  pty: Pty.Interface
  scope: Scope.Closeable
  attachment?: Pty.Attachment
  // 已完成行（去 ANSI）的缓冲；base 是被丢弃的前缀字符数，cursor 为模型已读到的绝对位置
  text: string
  base: number
  cursor: number
  // 尚未换行的末行（原始），读取时清洗后附带
  partial: string
  shown: string
  lastOutputAt: number
  sink?: WriteStream
  waiters: Set<Waiter>
  // 模型已通过 wait/read 感知退出，或主动 kill 时不再注入退出通知
  reported: boolean
  // 超时转后台的前台命令没有终端，也不接收输入
  input: boolean
  note?: Note
  exited: Promise<void>
  markExited: () => void
}

const jobs = new Map<string, Job>()

export const locationNode = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: locationServiceMapLayer,
  deps: [],
})

/** 清洗一行 PTY 输出：去 ANSI，按 \r 只保留最后一帧（进度条覆盖写）。 */
function clean(line: string) {
  const plain = stripAnsi(line).replace(/\r+$/, "")
  const index = plain.lastIndexOf("\r")
  return (index === -1 ? plain : plain.slice(index + 1)).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
}

function append(job: Job, chunk: string) {
  job.lastOutputAt = Date.now()
  const combined = job.partial + chunk
  const lines = combined.split("\n")
  job.partial = lines.pop() ?? ""
  if (lines.length) {
    const added = lines.map(clean).join("\n") + "\n"
    job.text += added
    job.sink?.write(added)
    if (job.text.length > TEXT_LIMIT) {
      const excess = job.text.length - TEXT_LIMIT
      job.text = job.text.slice(excess)
      job.base += excess
    }
  }
  wake(job)
}

function wake(job: Job) {
  if (!job.waiters.size) return
  const end = job.base + job.text.length
  const tail = clean(job.partial)
  for (const waiter of job.waiters) {
    if (job.info.status !== "running") {
      waiter.resolve()
      continue
    }
    if (!waiter.until) continue
    const from = Math.max(waiter.from, job.base) - job.base
    const fresh = job.text.slice(from, end - job.base) + tail
    if (waiter.until.test(fresh)) waiter.resolve()
  }
}

function finish(job: Job, status: Status, exitCode?: number) {
  if (job.info.status !== "running") return
  if (job.partial) {
    const last = clean(job.partial)
    job.partial = ""
    if (last) {
      job.text += last + "\n"
      job.sink?.write(last + "\n")
    }
  }
  job.info.status = status
  job.info.exitCode = exitCode
  job.info.endedAt = Date.now()
  job.sink?.end()
  job.sink = undefined
  job.attachment?.detach()
  job.markExited()
  wake(job)
  Effect.runFork(Scope.close(job.scope, Exit.void))
  if (!job.reported && status === "exited") {
    // 等一个 tick，让同时在 wait 的调用先标记 reported
    setTimeout(() => {
      if (job.reported) return
      job.reported = true
      job.note?.(job.info, lastLines(unread(job).text, 20))
    }, 50)
  }
  prune()
}

function prune() {
  const done = [...jobs.values()]
    .filter((job) => job.info.status !== "running")
    .toSorted((a, b) => (a.info.endedAt ?? 0) - (b.info.endedAt ?? 0))
  while (done.length > FINISHED_LIMIT) {
    const job = done.shift()
    if (job) jobs.delete(job.info.id)
  }
}

function lastLines(text: string, count: number) {
  const lines = text.replace(/\n$/, "").split("\n")
  if (lines.length <= count) return lines.join("\n")
  return `...(${lines.length - count} earlier lines)\n` + lines.slice(-count).join("\n")
}

function unread(job: Job) {
  const from = Math.max(job.cursor, job.base)
  const skipped = from - job.cursor
  let text = job.text.slice(from - job.base) + (job.partial ? clean(job.partial) : "")
  // 上次已返回过的未换行末行（如输入提示）不重复给出
  if (job.shown && text.startsWith(job.shown)) text = text.slice(job.shown.length)
  return { text, skipped }
}

/** 取出未读输出并推进游标；未换行的末行记为已展示，补全成整行后只返回新增部分。 */
function consume(job: Job) {
  const out = unread(job)
  const partial = job.partial ? clean(job.partial) : ""
  job.shown = partial
  job.cursor = job.base + job.text.length
  return out
}

export function running(sessionID: string) {
  return [...jobs.values()].filter((job) => job.info.sessionID === sessionID && job.info.status === "running")
}

export function list(sessionID: string) {
  return [...jobs.values()].filter((job) => job.info.sessionID === sessionID).map((job) => view(job))
}

export function get(id: string, sessionID: string) {
  const job = jobs.get(id)
  if (!job || job.info.sessionID !== sessionID) throw new Error(`No background job with id ${id} in this session`)
  return job
}

/** 进程在跑、输出已静默一段时间且末行未换行（像提示符）时，认为可能在等输入。 */
export function waitingForInput(job: Job) {
  if (job.info.status !== "running") return false
  if (Date.now() - job.lastOutputAt < PROMPT_IDLE_MS) return false
  return clean(job.partial).trim().length > 0
}

export function view(job: Job) {
  return {
    ...job.info,
    waitingForInput: waitingForInput(job),
    unreadChars: Math.max(0, job.base + job.text.length - job.cursor),
  }
}

export const start = Effect.fn("ShellJobs.start")(function* (input: {
  sessionID: string
  directory: string
  shell: string
  command: string
  description?: string
  cwd: string
  env: Record<string, string | undefined>
  logDir: string
  note?: Note
}) {
  checkCapacity(input.sessionID)
  const { pty, scope } = yield* acquire(input.directory)
  const launch = Shell.launch(input.shell, input.command, input.cwd, { interactive: true })
  const env = Object.fromEntries(
    Object.entries(input.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
  const created = yield* pty.create({
    command: launch.command,
    args: launch.args,
    cwd: input.cwd,
    env: { ...env, OPENCODE_BACKGROUND_JOB: "1" },
    title: input.description || input.command.split("\n")[0]!.slice(0, 60),
  })
  return yield* track({ ...input, pty, scope, created, input: true })
})

function checkCapacity(sessionID: string) {
  if (running(sessionID).length >= MAX_RUNNING) {
    throw new Error(
      `Too many background jobs running in this session (max ${MAX_RUNNING}). Kill finished or unneeded jobs with bash_job first.`,
    )
  }
}

export function hasCapacity(sessionID: string) {
  return running(sessionID).length < MAX_RUNNING
}

const acquire = Effect.fnUntraced(function* (directory: string) {
  const locations = yield* LocationServiceMap.Service
  // 作业存活期间持有 location 服务引用，避免 LayerMap 空闲回收时连带杀掉 PTY
  const scope = yield* Scope.make()
  const services = yield* Layer.buildWithScope(
    locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory) })),
    scope,
  )
  return { pty: Context.get(services, Pty.Service), scope }
})

/** 把已在运行的前台进程接管为后台作业：登记到 Pty.Service，终端面板与只读订阅照常可用。 */
export const adopt = Effect.fn("ShellJobs.adopt")(function* (input: {
  sessionID: string
  directory: string
  shell: string
  command: string
  description?: string
  cwd: string
  logDir: string
  process: Pty.Process
  replay: string
  note?: Note
}) {
  checkCapacity(input.sessionID)
  const { pty, scope } = yield* acquire(input.directory)
  const created = yield* pty.adopt({
    process: input.process,
    title: input.description || input.command.split("\n")[0]!.slice(0, 60),
    command: input.shell,
    args: ["-c", input.command],
    cwd: input.cwd,
    replay: input.replay,
  })
  return yield* track({ ...input, pty, scope, created, input: false })
})

const track = Effect.fnUntraced(function* (input: {
  sessionID: string
  command: string
  description?: string
  cwd: string
  logDir: string
  note?: Note
  pty: Pty.Interface
  scope: Scope.Closeable
  created: Pty.Info
  input: boolean
}) {
  const { pty, scope, created } = input
  yield* Effect.promise(() => mkdir(input.logDir, { recursive: true })).pipe(Effect.ignore)
  const log = path.join(input.logDir, `${created.id}.log`)
  let markExited = () => {}
  const exited = new Promise<void>((resolve) => (markExited = resolve))
  const job: Job = {
    info: {
      id: created.id,
      sessionID: input.sessionID,
      command: input.command,
      description: input.description,
      cwd: input.cwd,
      pid: created.pid,
      status: "running",
      startedAt: Date.now(),
      log,
    },
    pty,
    scope,
    text: "",
    base: 0,
    cursor: 0,
    partial: "",
    shown: "",
    lastOutputAt: Date.now(),
    sink: createWriteStream(log, { flags: "a" }),
    waiters: new Set(),
    reported: false,
    input: input.input,
    note: input.note,
    exited,
    markExited,
  }
  job.sink?.on("error", () => (job.sink = undefined))
  jobs.set(created.id, job)
  const attachment = yield* pty.attach(PtyID.make(created.id), {
    cursor: 0,
    onData: (chunk) => append(job, chunk),
    onEnd: (event) => finish(job, event.exitCode === undefined ? "killed" : "exited", event.exitCode),
  }).pipe(
    Effect.catch(() => {
      // attach 前就已退出：拿不到输出，只能标记结束
      finish(job, "exited")
      return Effect.succeed(undefined)
    }),
  )
  job.attachment = attachment
  if (attachment) {
    append(job, attachment.replay)
    attachment.activate()
  }
  return job
})

/** 等输出安静下来（至少 minMs，之后 quietMs 内无新输出）、进程退出或到 maxMs，返回未读输出并推进游标。 */
export const settle = Effect.fn("ShellJobs.settle")(function* (
  job: Job,
  input: { minMs: number; quietMs: number; maxMs: number; signal?: AbortSignal },
) {
  const started = Date.now()
  while (job.info.status === "running" && !input.signal?.aborted) {
    const now = Date.now()
    if (now - started >= input.maxMs) break
    if (now - started >= input.minMs && now - job.lastOutputAt >= input.quietMs) break
    yield* Effect.sleep("100 millis")
  }
  return consume(job)
})

/** 等待新输出匹配 until、进程退出或超时，然后返回自上次读取以来的输出并推进游标。 */
export const read = Effect.fn("ShellJobs.read")(function* (
  job: Job,
  input: { waitMs: number; until?: RegExp; exit?: boolean; signal?: AbortSignal },
) {
  const from = job.cursor
  const satisfied = () => {
    if (job.info.status !== "running") return true
    if (input.exit || !input.until) return false
    return input.until.test(unread(job).text)
  }
  if (input.waitMs > 0 && !satisfied()) {
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          const waiter: Waiter = {
            until: input.exit ? undefined : input.until,
            from,
            resolve: () => {
              clearTimeout(timer)
              input.signal?.removeEventListener("abort", waiter.resolve)
              job.waiters.delete(waiter)
              resolve()
            },
          }
          const timer = setTimeout(waiter.resolve, input.waitMs)
          input.signal?.addEventListener("abort", waiter.resolve, { once: true })
          job.waiters.add(waiter)
        }),
    )
  }
  const out = consume(job)
  if (job.info.status !== "running") job.reported = true
  return { ...out, matched: input.until ? input.until.test(out.text) : undefined, timedOut: !satisfied() }
})

const KEYS: Record<string, string> = {
  enter: "\r",
  tab: "\t",
  esc: "\x1b",
  escape: "\x1b",
  backspace: "\x7f",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  "ctrl-c": "\x03",
  "ctrl-d": "\x04",
  "ctrl-z": "\x1a",
  "ctrl-l": "\x0c",
  space: " ",
  y: "y",
  n: "n",
}

export function keyNames() {
  return Object.keys(KEYS)
}

export function write(job: Job, input: { text?: string; submit: boolean; keys?: readonly string[] }) {
  if (job.info.status !== "running") throw new Error(`Job ${job.info.id} is not running (status: ${job.info.status})`)
  if (!job.input) {
    throw new Error(`Job ${job.info.id} was moved to the background after a foreground timeout and has no stdin; it cannot receive input`)
  }
  let data = (input.text ?? "").replace(/\r?\n/g, "\r")
  for (const key of input.keys ?? []) {
    const seq = KEYS[key.toLowerCase()]
    if (seq === undefined) throw new Error(`Unknown key "${key}". Supported: ${keyNames().join(", ")}`)
    data += seq
  }
  if (input.submit && input.text !== undefined && !data.endsWith("\r")) data += "\r"
  if (!data) throw new Error("Nothing to write: provide input text or keys")
  job.attachment?.write(data)
}

export const kill = Effect.fn("ShellJobs.kill")(function* (job: Job) {
  if (job.info.status !== "running") return false
  job.reported = true
  yield* job.pty.remove(PtyID.make(job.info.id)).pipe(Effect.ignore)
  // remove 会触发 onEnd（exitCode 为空），兜底再标记一次
  finish(job, "killed")
  return true
})

export function markReported(job: Job) {
  job.reported = true
}

export function formatAge(ms: number) {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60}s`
  return `${Math.floor(m / 60)}h${m % 60}m`
}

export function unreadText(job: Job) {
  return unread(job)
}

export type Handle = Job

export * as ShellJobs from "./jobs"
