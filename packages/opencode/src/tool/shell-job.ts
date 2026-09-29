import { Effect, Schema } from "effect"
import path from "path"
import * as Tool from "./tool"
import * as Truncate from "./truncate"
import { ShellJobs } from "./shell/jobs"
import { askInput, tail } from "./shell"

const Action = Schema.Literals(["list", "read", "write", "wait", "kill"])

export const Parameters = Schema.Struct({
  action: Action.annotate({
    description:
      "list: show this session's background jobs. read: return output produced since your last read. write: send input to the process. wait: wait until the process exits. kill: stop the process.",
  }),
  id: Schema.optional(Schema.String).annotate({ description: "Job id returned by bash with background=true" }),
  input: Schema.optional(Schema.String).annotate({
    description: "write: text to type into the process. Enter is pressed afterwards unless submit=false.",
  }),
  submit: Schema.optional(Schema.Boolean).annotate({
    description: "write: press Enter after input (default true)",
  }),
  keys: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: `write: special keys sent after input, in order. One of: ${ShellJobs.keyNames().join(", ")}`,
  }),
  until: Schema.optional(Schema.String).annotate({
    description:
      "read/write: JavaScript regex; wait until new output matches it (e.g. a server's ready line or an input prompt), the process exits, or timeout_ms passes",
  }),
  timeout_ms: Schema.optional(Schema.Number).annotate({
    description:
      "Maximum time to wait in ms. read without until: wait for output to settle (default 0 = return immediately). read/write with until: default 30000. wait: default 60000. Max 600000.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

const SHELLS = new Set(["bash", "sh", "zsh", "fish", "dash", "ksh", "nu", "cmd", "cmd.exe"])
const PS = new Set(["pwsh", "powershell", "pwsh.exe", "powershell.exe"])
const REPLS = new Set([
  "python",
  "python3",
  "ipython",
  "node",
  "bun",
  "deno",
  "irb",
  "ruby",
  "php",
  "lua",
  "ghci",
  "julia",
  "R",
  "psql",
  "mysql",
  "sqlite3",
  "redis-cli",
  "mongosh",
  "mongo",
  "ssh",
  "docker",
  "kubectl",
])

/** 判断作业是否是能执行任意命令的 shell/REPL；只有这类作业的输入需要走权限检查。 */
function inputKind(command: string): "shell" | "ps" | "repl" | undefined {
  const words = command.trim().split(/\s+/)
  const program = path.basename(words[0] ?? "").replace(/\.exe$/i, "")
  if (SHELLS.has(program) || SHELLS.has(program.toLowerCase())) return "shell"
  if (PS.has(program.toLowerCase())) return "ps"
  // 带脚本参数的解释器（python app.py）不是 REPL，但 docker/kubectl 只有 exec -it 才算
  if (program === "docker" || program === "kubectl") return words.includes("exec") ? "repl" : undefined
  if (REPLS.has(program)) return words.length === 1 || words.some((word) => word === "-i") ? "repl" : undefined
  return undefined
}

function regex(value: string | undefined) {
  if (!value) return
  try {
    return new RegExp(value, "m")
  } catch (error) {
    throw new Error(`Invalid until regex: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function clamp(value: number | undefined, fallback: number) {
  return Math.max(0, Math.min(600_000, value ?? fallback))
}

export const ShellJobTool = Tool.define(
  "bash_job",
  Effect.gen(function* () {
    const trunc = yield* Truncate.Service

    return {
      description: [
        "Manage background commands started with bash background=true: list jobs, read new output, send input to interactive programs, wait for exit, or kill.",
        "read returns only output produced since your previous read of that job; use until to wait for a specific line (e.g. a server's 'ready' message or an input prompt) instead of polling.",
        "write types text into the process's terminal (Enter is pressed unless submit=false) and returns the output that follows; use keys for ctrl-c, arrows, etc.",
        "Jobs belong to the current session. Kill servers and watchers you no longer need.",
      ].join(" "),
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const limits = yield* trunc.limits()
          const format = (job: ShellJobs.Handle, text: string, extra: string[] = []) => {
            const state = ShellJobs.view(job)
            const shown = tail(text.replace(/\n+$/, ""), limits.maxLines, limits.maxBytes)
            const status =
              state.status === "running"
                ? state.waitingForInput
                  ? "running (appears to be waiting for input)"
                  : "running"
                : state.status === "killed"
                  ? "killed"
                  : `exited with code ${state.exitCode ?? "unknown"}`
            const body = shown.cut ? `...(earlier output omitted, full log: ${state.log})\n${shown.text}` : shown.text
            return {
              title: `${params.action} ${state.description || state.command.split("\n")[0]}`,
              output: [`Job ${state.id}: ${status}`, ...extra, "", body || "(no new output)"].join("\n"),
              metadata: {
                action: params.action,
                jobId: state.id,
                command: state.command,
                status: state.status,
                exit: state.exitCode ?? null,
                waitingForInput: state.waitingForInput,
                output: shown.text,
                input: params.input,
                keys: params.keys,
                log: state.log,
              } as Record<string, unknown>,
            }
          }

          if (params.action === "list") {
            const items = ShellJobs.list(ctx.sessionID)
            const now = Date.now()
            const lines = items.map((item) => {
              const status =
                item.status === "running"
                  ? `running ${ShellJobs.formatAge(now - item.startedAt)}${item.waitingForInput ? ", waiting for input" : ""}`
                  : item.status === "killed"
                    ? "killed"
                    : `exited ${item.exitCode ?? "?"}`
              return `${item.id}  [${status}]  ${item.unreadChars ? `${item.unreadChars} unread chars  ` : ""}${item.command.split("\n")[0]}`
            })
            return {
              title: "list background jobs",
              output: lines.length ? lines.join("\n") : "No background jobs in this session.",
              metadata: {
                action: params.action,
                jobs: items.map((item) => ({
                  id: item.id,
                  command: item.command,
                  status: item.status,
                  exit: item.exitCode ?? null,
                })),
              } as Record<string, unknown>,
            }
          }

          if (!params.id) throw new Error(`id is required for action=${params.action}`)
          const job = ShellJobs.get(params.id, ctx.sessionID)

          if (params.action === "kill") {
            const killed = yield* ShellJobs.kill(job)
            const rest = ShellJobs.unreadText(job).text
            return format(job, rest, killed ? [] : ["(job had already finished)"])
          }

          if (params.action === "wait") {
            const result = yield* ShellJobs.read(job, {
              waitMs: clamp(params.timeout_ms, 60_000),
              exit: true,
              signal: ctx.abort,
            })
            const extra = job.info.status === "running" ? ["Still running after timeout."] : []
            return format(job, result.text, extra)
          }

          if (params.action === "write") {
            if (params.input !== undefined) {
              const kind = inputKind(job.info.command)
              if (kind) yield* askInput(ctx, params.input, kind, job.info)
            }
            ShellJobs.write(job, { text: params.input, submit: params.submit ?? true, keys: params.keys })
            const until = regex(params.until)
            if (until) {
              const result = yield* ShellJobs.read(job, {
                waitMs: clamp(params.timeout_ms, 30_000),
                until,
                signal: ctx.abort,
              })
              return format(job, result.text, result.matched ? [] : ["(until pattern not matched before timeout)"])
            }
            const result = yield* ShellJobs.settle(job, {
              minMs: 300,
              quietMs: 500,
              maxMs: clamp(params.timeout_ms, 5_000),
              signal: ctx.abort,
            })
            return format(job, result.text)
          }

          const until = regex(params.until)
          if (until) {
            const result = yield* ShellJobs.read(job, {
              waitMs: clamp(params.timeout_ms, 30_000),
              until,
              signal: ctx.abort,
            })
            return format(job, result.text, result.matched ? [] : ["(until pattern not matched before timeout)"])
          }
          if (params.timeout_ms) {
            // 先等到有新输出，再等它安静下来，避免把一次输出拆成两半
            const first = yield* ShellJobs.read(job, {
              waitMs: clamp(params.timeout_ms, 0),
              until: /\S/,
              signal: ctx.abort,
            })
            const rest = yield* ShellJobs.settle(job, { minMs: 0, quietMs: 500, maxMs: 3_000, signal: ctx.abort })
            return format(job, first.text + rest.text)
          }
          const result = yield* ShellJobs.read(job, { waitMs: 0 })
          return format(job, result.text)
        }).pipe(Effect.orDie),
    }
  }),
)
