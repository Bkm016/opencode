import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { Effect, FileSystem, Schema } from "effect"
import { which } from "@opencode-ai/core/util/which"

export type Method =
  | "list_windows"
  | "list_apps"
  | "set_value"
  | "perform_secondary_action"
  | "get_window_state"
  | "activate_window"
  | "get_window"
  | "click"
  | "click_element"
  | "type_text"
  | "press_key"
  | "scroll"
  | "drag"
  | "launch_app"
  | "end_turn"

export type Turn = { session_id: string; turn_id: string }
export type Approval = { app: string; displayName: string; riskLevel?: "low" | "high" }
export type Reply = { result?: unknown; approvalRequest?: Approval; revision: number }

export const INTERRUPTED =
  "Computer Use was stopped by the user with the physical Escape key. Stop your work, do not call further Computer Use tools in this turn, and send a final message noting that the user stopped Computer Use."

const TIMEOUT = 30_000
const MAX_FRAME = 64 * 1024 * 1024

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// 仅发现并启动已安装的官方程序，不写入 Codex 的资源、认证或批准记录。
export function open(fs: FileSystem.FileSystem, onInterrupt: (turn: Turn) => void) {
  return Effect.gen(function* () {
    if (process.platform !== "win32") throw new Error("computer_use requires a local Windows desktop server.")
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
    const root = path.join(local, "OpenAI", "Codex")
    const helperOverride = process.env.OPENCODE_COMPUTER_USE_HELPER?.trim()
    const cliOverride = process.env.CODEX_CLI_PATH?.trim()
    // 显式覆盖必须有效，不能静默换成另一份可执行文件。
    for (const candidate of [helperOverride, cliOverride]) {
      if (!candidate) continue
      const file = yield* fs.stat(candidate).pipe(Effect.option)
      if (
        !path.isAbsolute(candidate) ||
        path.extname(candidate).toLowerCase() !== ".exe" ||
        file._tag !== "Some" ||
        file.value.type !== "File"
      ) {
        throw new Error(`Invalid Codex executable override: ${candidate}. Expected an existing absolute .exe path.`)
      }
    }
    if (helperOverride && cliOverride) return new WindowsComputerUse(helperOverride, cliOverride, onInterrupt)

    const resources: string[] = []
    const caches = [root]
    const diagnostics: string[] = []
    const clients: string[] = []
    // Store 安装包自带配套 helper 与 CLI；目录不可读时退回用户缓存，不提权。
    if (process.env.ProgramFiles) {
      const directory = path.join(process.env.ProgramFiles, "WindowsApps")
      const packages = yield* fs.readDirectory(directory).pipe(
        Effect.catch((error) => {
          if (error.reason._tag !== "NotFound") diagnostics.push(`${directory}: ${String(error)}`)
          return Effect.succeed([] as string[])
        }),
      )
      resources.push(
        ...packages
          .filter((name) => /^OpenAI\.Codex_\d/i.test(name))
          .toSorted((a, b) => b.localeCompare(a, "en", { numeric: true }))
          .map((name) => path.join(directory, name, "app", "resources")),
      )
    }
    // Chrome 元数据可能仍指向卸载过的旧版本，仅作为候选，后续必须检查实际文件。
    for (const directory of [root, process.env.CODEX_HOME || path.join(os.homedir(), ".codex")]) {
      const metadata = yield* fs.readFileString(path.join(directory, "chrome-native-hosts.json")).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)),
        Effect.option,
      )
      if (metadata._tag !== "Some" || !record(metadata.value) || !Array.isArray(metadata.value.chromeNativeHosts)) continue
      for (const entry of metadata.value.chromeNativeHosts) {
        if (!record(entry)) continue
        if (typeof entry.resourcesPath === "string" && path.isAbsolute(entry.resourcesPath)) resources.push(entry.resourcesPath)
        if (typeof entry.codexCliPath === "string" && path.isAbsolute(entry.codexCliPath)) clients.push(entry.codexCliPath)
      }
    }
    const executable = which("codex.exe")
    if (executable && !path.dirname(executable).toLowerCase().endsWith("\\microsoft\\windowsapps")) {
      clients.push(executable)
      resources.push(path.dirname(executable), path.join(path.dirname(executable), "resources"))
    }
    for (const install of [
      path.join(local, "Programs", "Codex"),
      path.join(local, "Codex"),
      ...(process.env.ProgramFiles ? [path.join(process.env.ProgramFiles, "Codex")] : []),
    ]) {
      resources.push(path.join(install, "resources"), path.join(install, "app", "resources"))
    }
    // 只枚举 Store 的一层包目录，不递归扫描安装盘，也不依赖固定 PackageFamilyName。
    const packages = yield* fs.readDirectory(path.join(local, "Packages")).pipe(
      Effect.catch(() => Effect.succeed([] as string[])),
    )
    caches.push(
      ...packages
        .filter((name) => /^OpenAI\.Codex_/i.test(name))
        .map((name) => path.join(local, "Packages", name, "LocalCache", "Local", "OpenAI", "Codex")),
    )
    const groups: { runtimes: string[]; clients: string[]; source: string }[] = [...new Set(resources)].map((directory) => ({
      runtimes: [path.join(directory, "cua_node")],
      clients: [path.join(directory, "codex.exe")],
      source: directory,
    }))
    for (const cache of [...new Set(caches)]) {
      const runtimes = path.join(cache, "runtimes", "cua_node")
      const bin = path.join(cache, "bin")
      const entries = yield* Effect.forEach([runtimes, bin], (directory) =>
        fs.readDirectory(directory).pipe(
          Effect.catch((error) => {
            if (error.reason._tag !== "NotFound") diagnostics.push(`${directory}: ${String(error)}`)
            return Effect.succeed([] as string[])
          }),
        ),
      )
      groups.push({
        runtimes: [runtimes, ...entries[0].map((entry) => path.join(runtimes, entry))],
        clients: [path.join(bin, "codex.exe"), ...entries[1].map((entry) => path.join(bin, entry, "codex.exe"))],
        source: cache,
      })
    }
    const candidates = yield* Effect.forEach(groups, (group) =>
      Effect.gen(function* () {
        const files = yield* Effect.forEach(
          [
            helperOverride
              ? [helperOverride]
              : group.runtimes.flatMap((runtime) =>
                  ["cua", "sky"].flatMap((name) =>
                    (process.arch === "arm64"
                      ? ["codex-computer-use-arm64.exe", "codex-computer-use.exe"]
                      : ["codex-computer-use.exe"]
                    ).map((filename) => path.join(runtime, "bin", "node_modules", "@oai", name, "bin", "windows", filename)),
                  ),
                ),
            cliOverride ? [cliOverride] : group.clients,
          ],
          (paths) => Effect.forEach([...new Set(paths)], (filename) =>
            fs.stat(filename).pipe(
              Effect.map((stat) => stat.type === "File"
                ? { filename, modified: stat.mtime._tag === "Some" ? stat.mtime.value.getTime() : 0 }
                : undefined),
              Effect.catch((error) => {
                if (error.reason._tag !== "NotFound") diagnostics.push(`${filename}: ${String(error)}`)
                return Effect.succeed(undefined)
              }),
            ),
          ),
        )
        // 哈希名不具备版本含义；缓存兜底按文件时间选择，安装包中的配对文件始终优先。
        return {
          helpers: files[0].filter((file) => file !== undefined).toSorted((a, b) => b.modified - a.modified),
          clients: files[1].filter((file) => file !== undefined).toSorted((a, b) =>
            Number(b.filename === group.clients[0]) - Number(a.filename === group.clients[0]) || b.modified - a.modified,
          ),
        }
      }),
    )
    const paired = candidates.find((group) => group.helpers.length && group.clients.length)
    if (paired) return new WindowsComputerUse(paired.helpers[0].filename, paired.clients[0].filename, onInterrupt)
    const helper = helperOverride || candidates.flatMap((group) => group.helpers)[0]?.filename
    const fallbackClients = cliOverride ? [cliOverride] : [...candidates.flatMap((group) => group.clients.map((file) => file.filename)), ...clients]
    if (helper) {
      for (const cli of [...new Set(fallbackClients)]) {
        if (!path.isAbsolute(cli) || path.extname(cli).toLowerCase() !== ".exe") continue
        const file = yield* fs.stat(cli).pipe(Effect.option)
        if (file._tag === "Some" && file.value.type === "File") return new WindowsComputerUse(helper, cli, onInterrupt)
      }
    }
    throw new Error([
      helper ? "Codex computer-use helper found, but Codex CLI is missing." : "Codex computer-use helper not found in installed applications or runtime caches.",
      "Install/update the Codex desktop app with Computer Use available. Installing only the CLI is not sufficient.",
      "For a custom installation, set OPENCODE_COMPUTER_USE_HELPER and CODEX_CLI_PATH to existing absolute .exe paths.",
      `Searched: ${groups.map((group) => group.source).join("; ")}`,
      ...diagnostics,
    ].join("\n"))
  })
}

// 桌面 helper 的元素索引与截图缓存在进程内；逐次 spawn 会丢失这些状态。
export class WindowsComputerUse {
  readonly child: ChildProcessWithoutNullStreams
  readonly codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"))
  readonly closed: Promise<void>
  turn?: Turn
  revision = 0
  usable = true
  exited = false
  pending?: { id: number; resume: (reply: Effect.Effect<Reply, Error>) => void; cleanup: () => void }
  sequence = 0
  buffer = ""
  stderr = ""
  idle?: ReturnType<typeof setTimeout>

  constructor(
    helper: string,
    cli: string,
    readonly onInterrupt: (turn: Turn) => void,
  ) {
    this.child = spawn(helper, ["--parent-pid", String(process.pid)], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CODEX_CLI_PATH: cli, CODEX_HOME: this.codexHome },
    })
    this.child.unref()
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      if ("unref" in stream && typeof stream.unref === "function") stream.unref()
    }
    const exit = () => this.child.kill()
    process.once("exit", exit)
    this.closed = new Promise<void>((resolve) => {
      // 子进程可能继承 stdio；helper 已退出即可确认不再操作桌面，不等待后代关闭管道。
      const settled = () => {
        this.exited = true
        process.off("exit", exit)
        this.child.stdin.destroy()
        this.child.stdout.destroy()
        this.child.stderr.destroy()
        resolve()
      }
      this.child.once("exit", settled)
      this.child.once("close", settled)
      this.child.once("error", () => {
        if (!this.child.pid) settled()
      })
    })
    this.child.stdout.setEncoding("utf8")
    this.child.stderr.setEncoding("utf8")
    this.child.stdout.on("data", (chunk: string) => this.receive(chunk))
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-8192)
    })
    this.child.stdin.on("error", (error) => this.fail(error))
    this.child.on("error", (error) => this.fail(error))
    this.child.on("exit", (code, signal) => {
      if (code === 130 && this.turn) this.onInterrupt(this.turn)
      this.fail(
        new Error(code === 130 ? INTERRUPTED : `Codex computer-use helper exited (${code ?? signal}). ${this.stderr}`),
      )
    })
    this.touch()
  }

  touch() {
    clearTimeout(this.idle)
    this.idle = setTimeout(
      () => this.fail(new Error("Computer-use helper expired; observe the window again.")),
      120_000,
    )
    this.idle.unref()
  }

  request(method: Method, params: Record<string, unknown>, turn: Turn, signal: AbortSignal, approvedApp?: string) {
    return Effect.callback<Reply, Error>((resume) => {
      if (!this.usable || this.pending) {
        resume(Effect.fail(new Error("Computer-use helper is unavailable or busy; no action was sent.")))
        return
      }
      if (signal.aborted) {
        resume(Effect.fail(new Error("Computer use was cancelled; no action was sent.")))
        return
      }
      this.touch()
      this.turn = turn
      const id = ++this.sequence
      const abort = () =>
        this.fail(new Error("Computer use was cancelled. Do not replay the action; its outcome may be unknown."))
      const timer = setTimeout(
        () =>
          this.fail(
            new Error(`Computer use timed out during ${method}. Do not replay the action; its outcome may be unknown.`),
          ),
        TIMEOUT,
      )
      signal.addEventListener("abort", abort, { once: true })
      this.pending = {
        id,
        resume,
        cleanup: () => {
          clearTimeout(timer)
          signal.removeEventListener("abort", abort)
        },
      }
      this.child.stdin.write(
        JSON.stringify({
          id,
          method,
          params,
          meta: {
            ...turn,
            "x-oai-cua-request-budget-ms": TIMEOUT,
            ...(approvedApp ? { "x-oai-cua-approved-app": approvedApp } : {}),
          },
        }) + "\n",
        (error) => {
          if (error) this.fail(error)
        },
      )
      // Effect 中断必须等待原进程退出，再释放桌面锁，避免取消后的操作与新请求重叠。
      return Effect.promise(() => this.stop())
    })
  }

  receive(chunk: string) {
    if (!this.usable) return
    this.buffer += chunk
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_FRAME) {
      this.fail(new Error("Codex computer-use helper response exceeded 64 MiB."))
      return
    }
    for (;;) {
      const end = this.buffer.indexOf("\n")
      if (end < 0) return
      const line = this.buffer.slice(0, end).trim()
      this.buffer = this.buffer.slice(end + 1)
      if (!line) continue
      try {
        const message: unknown = JSON.parse(line)
        if (!record(message)) throw new Error("Invalid computer-use response object.")
        if (typeof message.error === "string" && /physical (Escape|Esc) key/i.test(message.error)) {
          if (this.turn) this.onInterrupt(this.turn)
          this.fail(new Error(INTERRUPTED))
          return
        }
        // 未知通知可能代表截图缓存失效；宁可要求重新观察，也不沿用旧索引。
        if (typeof message.id !== "number") {
          this.revision++
          continue
        }
        const pending = this.pending
        if (!pending || pending.id !== message.id) throw new Error("Unexpected computer-use response ID.")
        if (typeof message.ok !== "boolean") throw new Error("Invalid computer-use response status.")
        const approval = message.approvalRequest
        if (!message.ok && approval !== undefined) {
          if (!record(approval) || typeof approval.app !== "string" || !approval.app.trim()) {
            throw new Error("Invalid computer-use app approval request.")
          }
          const risk = approval.riskLevel
          if (risk !== undefined && risk !== "low" && risk !== "high") {
            throw new Error("Unsupported computer-use approval risk level.")
          }
          this.pending = undefined
          pending.cleanup()
          pending.resume(
            Effect.succeed({
              approvalRequest: {
                app: approval.app,
                displayName: typeof approval.displayName === "string" ? approval.displayName : approval.app,
                riskLevel: risk,
              },
              revision: this.revision,
            }),
          )
          continue
        }
        if (!message.ok) {
          // 完整的业务拒绝不是传输损坏；保留 helper，允许恢复最小化窗口后重新观察。
          this.pending = undefined
          this.revision++
          pending.cleanup()
          pending.resume(Effect.fail(new Error(typeof message.error === "string" ? message.error : "Computer-use request failed.")))
          continue
        }
        this.pending = undefined
        pending.cleanup()
        pending.resume(Effect.succeed({ result: message.result, revision: this.revision }))
      } catch {
        this.fail(
          new Error("Invalid computer-use NDJSON response; the helper was stopped without replaying the action."),
        )
        return
      }
    }
  }

  fail(error: Error) {
    this.usable = false
    this.revision++
    this.buffer = ""
    clearTimeout(this.idle)
    const pending = this.pending
    this.pending = undefined
    pending?.cleanup()
    if (!this.exited) this.child.kill()
    if (pending) {
      // 失败也等待关闭；不能因 Promise 先 reject 就让下一会话获得仍在执行的桌面。
      void this.stop().then(
        () => pending.resume(Effect.fail(error)),
        () =>
          pending.resume(
            Effect.fail(new Error(`${error.message} Helper shutdown did not complete; desktop remains blocked.`)),
          ),
      )
    }
  }

  async stop() {
    this.usable = false
    this.buffer = ""
    clearTimeout(this.idle)
    const pending = this.pending
    this.pending = undefined
    pending?.cleanup()
    if (this.exited) return
    this.child.kill()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Computer-use helper is still stopping; desktop is blocked.")),
            5000,
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
}
