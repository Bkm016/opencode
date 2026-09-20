import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { Effect, Schema, Semaphore } from "effect"
import { Parser } from "htmlparser2"
import TurndownService from "turndown"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { ToolJsonSchema } from "./json-schema"
import * as Tool from "./tool"
import DESCRIPTION from "./browser.txt"

const NAVIGATION_TIMEOUT = 30_000
const REQUEST_TIMEOUT = 60_000
const IDLE_TIMEOUT = 120_000
const MAX_SCREENSHOT_BASE64 = 16 * 1024 * 1024
const MAX_EVALUATE_OUTPUT = 64 * 1024

const Selector = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))

// 各动作共用的元数据形状；显式标注避免 union 窄化推断出互斥类型。
interface Metadata {
  action: string
  url?: string
  title?: string
  selector?: string
  format?: string
}

export const Parameters = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("navigate"),
    url: Schema.String.annotate({ description: "The fully qualified URL to open in the browser tab." }),
    wait_until: Schema.optional(Schema.Literals(["load", "domcontentloaded", "networkidle"])).annotate({
      description: "Navigation settle condition (default load). Use networkidle for client-rendered apps.",
    }),
  }),
  Schema.Struct({
    action: Schema.Literal("screenshot"),
    full_page: Schema.optional(Schema.Boolean).annotate({
      description: "Capture the full scrollable page instead of only the viewport (default false).",
    }),
  }),
  Schema.Struct({
    action: Schema.Literal("get_content"),
    format: Schema.optional(Schema.Literals(["markdown", "text", "html"])).annotate({
      description: "Format of the rendered page content (default markdown).",
    }),
    selector: Schema.optional(Selector).annotate({
      description: "Restrict content to the first element matching this CSS selector instead of the whole page.",
    }),
  }),
  Schema.Struct({
    action: Schema.Literal("click"),
    selector: Selector.annotate({ description: "CSS selector of the element to click." }),
  }),
  Schema.Struct({
    action: Schema.Literal("type_text"),
    selector: Selector.annotate({ description: "CSS selector of the input element to type into." }),
    text: Schema.String.check(Schema.isMaxLength(100_000)),
    submit: Schema.optional(Schema.Boolean).annotate({ description: "Press Enter after typing (default false)." }),
  }),
  Schema.Struct({
    action: Schema.Literal("press_key"),
    key: Schema.String.annotate({ description: "Playwright key name, e.g. Enter, Tab, Escape, ArrowDown, Control+a." }),
  }),
  Schema.Struct({
    action: Schema.Literal("scroll"),
    delta_x: Schema.optional(Schema.Int).annotate({ description: "Horizontal wheel delta, negative left (default 0)." }),
    delta_y: Schema.optional(Schema.Int).annotate({ description: "Vertical wheel delta, negative up (default 600)." }),
  }),
  Schema.Struct({
    action: Schema.Literal("evaluate"),
    script: Schema.String.check(Schema.isMaxLength(100_000)).annotate({
      description:
        "JavaScript expression or function body evaluated in the page. The result must be JSON-serializable and is truncated to 64KB.",
    }),
  }),
  Schema.Struct({ action: Schema.Literal("back") }),
  Schema.Struct({ action: Schema.Literal("close") }),
])

interface Reply {
  id?: number
  result?: unknown
  error?: string
  event?: string
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  cleanup: () => void
}

// Bun 下 playwright-core 的 launch/connect 因子进程管道兼容问题挂死，
// 故浏览器由独立 node 子进程（browser-helper.ts）驱动，本侧只发 JSON-RPC。
// 浏览器进程跨实例共享，锁与单例句柄不能按 InstanceState 隔离；单页模型避免标签页竞争。
const tab = {
  lock: Semaphore.makeUnsafe(1),
  child: undefined as ChildProcessWithoutNullStreams | undefined,
  url: undefined as string | undefined,
  open: false,
  idle: undefined as ReturnType<typeof setTimeout> | undefined,
  sequence: 0,
  pending: new Map<number, Pending>(),
  buffer: "",
}

const MISSING_BROWSER =
  "No browser found. Install a Chromium-based browser, run `playwright install chromium-headless-shell`, or set OPENCODE_BROWSER_EXECUTABLE_PATH."

// node 可执行文件：打包运行时 process.execPath 就是运行 sidecar 的 node；dev（bun 运行）时回退 PATH 里的 node。
function nodeExecutable() {
  if (process.env.OPENCODE_NODE_PATH) return process.env.OPENCODE_NODE_PATH
  const base = path.basename(process.execPath).toLowerCase()
  if (base.startsWith("node")) return process.execPath
  return "node"
}

// helper 源文件与编译产物都放 os tmp，避免污染项目目录；内容变化时重建（按源文件 hash 判断）。
// 返回 script（helper 入口，须为独立 node 子进程可读的真实磁盘路径）与 anchor（createRequire 解析
// playwright-core 的锚点，须落在宿主依赖树内）。
async function helperScript(): Promise<{ script: string; anchor: string }> {
  // 打包运行时 build-node.ts 已把 helper bundle 成同目录 browser-helper.mjs，直接使用。
  // 本 bundle 跑在 app.asar 内；helper 由独立 node 子进程加载，asar 内文件对子进程不可见，
  // 须映射到 asarUnpack 落盘的 app.asar.unpacked 等价路径（其 node_modules 有 playwright-core，可作锚点）。
  const self = fileURLToPath(import.meta.url).replace("app.asar" + path.sep, "app.asar.unpacked" + path.sep)
  const bundled = path.join(path.dirname(self), "browser-helper.mjs")
  const fs = await import("node:fs/promises")
  if (await fs.stat(bundled).catch(() => undefined)) return { script: bundled, anchor: bundled }
  // 开发态源码是 .ts，需要即时编译到 os tmp 下的 .mjs；tmp 产物不在宿主依赖树内，锚点回退源码路径。
  const source = self.replace(/browser\.ts$/, "browser-helper.ts")
  const text = await fs.readFile(source, "utf8")
  const crypto = await import("node:crypto")
  const os = await import("node:os")
  const hash = crypto.createHash("sha1").update(text).digest("hex").slice(0, 12)
  const target = path.join(os.tmpdir(), `opencode-browser-helper-${hash}.mjs`)
  if (!(await fs.stat(target).catch(() => undefined))) {
    // 即时编译：strip 类型并保持 ESM import 语法；playwright-core 保持外部依赖在运行时解析。
    const { transpileModule, ModuleKind, ScriptTarget } = await import("typescript")
    const compiled = transpileModule(text, {
      compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
    })
    await fs.writeFile(target, compiled.outputText, "utf8")
  }
  return { script: target, anchor: source }
}

function kill() {
  const child = tab.child
  tab.child = undefined
  tab.open = false
  if (tab.idle) clearTimeout(tab.idle)
  for (const pending of tab.pending.values()) {
    pending.cleanup()
    pending.reject(new Error("Browser helper exited."))
  }
  tab.pending.clear()
  if (child && !child.killed) child.kill()
}

function touch() {
  if (tab.idle) clearTimeout(tab.idle)
  tab.idle = setTimeout(() => {
    const child = tab.child
    if (child) {
      // 空闲回收：通知 helper 关浏览器，helper 随之退出（stdin 断开）。
      child.stdin.end()
    }
    kill()
  }, IDLE_TIMEOUT)
  tab.idle.unref()
}

const spawnHelper = Effect.fn("Browser.spawnHelper")(function* () {
  const { script, anchor } = yield* Effect.tryPromise({
    try: () => helperScript(),
    catch: (error) => new Error(`Failed to prepare the browser helper: ${error instanceof Error ? error.message : error}`),
  })
  const child = spawn(nodeExecutable(), [script], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, OPENCODE_BROWSER_HELPER_RESOLVE: anchor },
    windowsHide: true,
  })
  child.unref()
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    if ("unref" in stream && typeof stream.unref === "function") stream.unref()
  }
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  let stderr = ""
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4096)
  })
  child.on("error", () => kill())
  child.on("exit", () => {
    if (stderr.trim() && tab.child) Effect.runSync(Effect.logWarning(`browser helper exited: ${stderr.trim()}`))
    kill()
  })
  child.stdout.on("data", (chunk: string) => {
    tab.buffer += chunk
    for (;;) {
      const newline = tab.buffer.indexOf("\n")
      if (newline < 0) break
      const line = tab.buffer.slice(0, newline).trim()
      tab.buffer = tab.buffer.slice(newline + 1)
      if (!line) continue
      let reply: Reply
      try {
        reply = JSON.parse(line)
      } catch {
        continue
      }
      // crash/disconnected 事件使当前页面失效，下个动作会重启浏览器。
      if (reply.event === "crash" || reply.event === "disconnected") {
        tab.open = false
        continue
      }
      if (reply.id === undefined) continue
      const pending = tab.pending.get(reply.id)
      if (!pending) continue
      tab.pending.delete(reply.id)
      pending.cleanup()
      if (reply.error !== undefined) pending.reject(new Error(reply.error))
      else pending.resolve(reply.result)
    }
  })
  tab.child = child
  touch()
  return child
})

// 发一个 JSON-RPC 请求；helper 未启动时按需启动。
function request(method: string, params: Record<string, unknown>, signal: AbortSignal) {
  return Effect.callback<unknown, Error>((resume) => {
    const child = tab.child
    if (!child || child.killed || child.exitCode !== null) {
      resume(Effect.fail(new Error("Browser helper is not running.")))
      return
    }
    if (signal.aborted) {
      resume(Effect.fail(new Error("Browser action was cancelled; no action was sent.")))
      return
    }
    const id = ++tab.sequence
    const timer = setTimeout(() => {
      finish()
      resume(Effect.fail(new Error(`Browser action timed out during ${method}. Do not replay; outcome may be unknown.`)))
    }, REQUEST_TIMEOUT)
    const abort = () => {
      finish()
      resume(Effect.fail(new Error("Browser action was cancelled. Do not replay the action; its outcome may be unknown.")))
    }
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      tab.pending.delete(id)
    }
    tab.pending.set(id, {
      cleanup: () => {
        clearTimeout(timer)
        signal.removeEventListener("abort", abort)
      },
      resolve: (value) => {
        finish()
        resume(Effect.succeed(value))
      },
      reject: (error) => {
        finish()
        resume(Effect.fail(error))
      },
    })
    signal.addEventListener("abort", abort, { once: true })
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n", (error) => {
      if (error) {
        finish()
        resume(Effect.fail(new Error(`Failed to reach the browser helper: ${error.message}`)))
      }
    })
  })
}

// 确保浏览器已打开页面；navigate 之前的交互动作报明确错误。
function ensure(signal: AbortSignal) {
  return Effect.gen(function* () {
    if (!tab.child || tab.child.killed || tab.child.exitCode !== null) {
      tab.buffer = ""
      yield* spawnHelper()
    }
    const state = (yield* request("current", {}, signal)) as { open?: boolean; url?: string }
    tab.open = state.open === true
    tab.url = state.url
    return tab.open
  })
}

function pngAttachment(base64: string, index: number) {
  if (base64.length > MAX_SCREENSHOT_BASE64) throw new Error("Screenshot exceeds the 12MB image limit.")
  const bytes = Buffer.from(base64, "base64")
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  if (!png && !jpeg) throw new Error("Screenshot bytes are neither PNG nor JPEG.")
  const mime = png ? "image/png" : "image/jpeg"
  return {
    type: "file" as const,
    mime,
    url: `data:${mime};base64,${base64}`,
    filename: `browser-${index}.${png ? "png" : "jpg"}`,
  }
}

function htmlToMarkdown(html: string): string {
  const turndown = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  turndown.remove(["script", "style", "meta", "link"])
  return turndown.turndown(html)
}

function htmlToText(html: string) {
  let text = ""
  let skipDepth = 0
  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0 || ["script", "style", "noscript", "iframe", "object", "embed"].includes(name)) skipDepth++
    },
    ontext(input) {
      if (skipDepth === 0) text += input
    },
    onclosetag() {
      if (skipDepth > 0) skipDepth--
    },
  })
  parser.write(html)
  parser.end()
  return text.trim()
}

// helper 报错文案归一化：把 playwright 堆栈压成单行，缺失浏览器给安装指引。
function describe(error: Error, action: string) {
  const message = error.message.split("\n")[0] ?? error.message
  if (/Executable doesn't exist|browserType\.launch|Failed to launch/i.test(error.message)) return MISSING_BROWSER
  return `${action} failed: ${message}`
}

export const BrowserTool = Tool.define(
  "browser",
  Effect.gen(function* () {
    // 宿主进程退出时兜底杀掉 helper，避免孤儿浏览器常驻。
    process.once("exit", kill)
    // 部分提供方不接受顶层 anyOf；模型描述由同一联合派生，执行时仍严格校验各动作必需字段。
    const jsonSchema = {
      type: "object",
      properties: {
        ...Object.fromEntries(
          Parameters.members.flatMap((member) => Object.entries(ToolJsonSchema.fromSchema(member).properties ?? {})),
        ),
        action: { type: "string", enum: Parameters.members.map((member) => member.fields.action.literal) },
      },
      required: ["action"],
    } satisfies JSONSchema7
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      jsonSchema,
      execute: (input: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        tab.lock.withPermits(1)(
          Effect.gen(function* () {
            const navigate = input.action === "navigate"
            // 交互动作的权限以当前页 URL 为 pattern，防止跳转后权限漂移。
            const open = yield* ensure(ctx.abort).pipe(
              Effect.catch((error) => Effect.fail(new Error(describe(error, input.action)))),
            )
            const url = navigate ? input.url : tab.url
            const detail = `${input.action}${url ? `: ${url}` : ""}`
            yield* ctx.metadata({ title: detail, metadata: { action: input.action, url  } as Metadata })
            yield* ctx.ask({
              permission: "browser",
              patterns: [url ?? "*", detail],
              always: [url ?? "*", `${input.action}: *`, "*"],
              metadata: { ...input, url },
            })
            if (ctx.abort.aborted) throw new Error("Browser action was cancelled; no action was sent.")
            if (!navigate && input.action !== "close" && !open) {
              throw new Error("No browser tab is open. Navigate to a URL first.")
            }

            const call = (method: string, params: Record<string, unknown>) =>
              request(method, params, ctx.abort).pipe(
                Effect.catch((error) => Effect.fail(new Error(describe(error, method)))),
                Effect.tap(() => Effect.sync(() => touch())),
              )

            switch (input.action) {
              case "navigate": {
                if (!input.url.startsWith("http://") && !input.url.startsWith("https://")) {
                  throw new Error("URL must start with http:// or https://")
                }
                const result = (yield* call("navigate", {
                  url: input.url,
                  wait_until: input.wait_until ?? "load",
                })) as { url: string; status: number | null; title: string }
                tab.open = true
                tab.url = result.url
                return {
                  title: detail,
                  metadata: { action: input.action, url: result.url, title: result.title  } as Metadata,
                  output: `Navigated to ${result.url}${result.title ? ` — ${result.title}` : ""}`,
                }
              }
              case "screenshot": {
                const result = (yield* call("screenshot", { full_page: input.full_page ?? false })) as {
                  url: string
                  base64: string
                }
                tab.url = result.url
                return {
                  title: detail,
                  metadata: { action: input.action, url: result.url  } as Metadata,
                  output: `Screenshot of ${result.url} captured.`,
                  attachments: [pngAttachment(result.base64, 1)],
                }
              }
              case "get_content": {
                const result = (yield* call("get_content", { selector: input.selector })) as {
                  url: string
                  html: string
                }
                tab.url = result.url
                const format = input.format ?? "markdown"
                const output =
                  format === "html" ? result.html : format === "text" ? htmlToText(result.html) : htmlToMarkdown(result.html)
                return {
                  title: detail,
                  metadata: { action: input.action, url: result.url, format  } as Metadata,
                  output: output || "The page rendered no readable content.",
                }
              }
              case "click": {
                const result = (yield* call("click", { selector: input.selector })) as { url: string }
                tab.url = result.url
                return {
                  title: detail,
                  metadata: { action: input.action, url: result.url, selector: input.selector  } as Metadata,
                  output: `Clicked ${input.selector}. The page may have changed; observe it again before the next action.`,
                }
              }
              case "type_text": {
                const result = (yield* call("type_text", {
                  selector: input.selector,
                  text: input.text,
                  submit: input.submit ?? false,
                })) as { url: string }
                tab.url = result.url
                return {
                  title: detail,
                  metadata: { action: input.action, url: result.url, selector: input.selector  } as Metadata,
                  output: `Typed into ${input.selector}${input.submit ? " and submitted" : ""}.`,
                }
              }
              case "press_key": {
                const result = (yield* call("press_key", { key: input.key })) as { url: string }
                tab.url = result.url
                return {
                  title: detail,
                  metadata: { action: input.action, url: result.url  } as Metadata,
                  output: `Pressed ${input.key}.`,
                }
              }
              case "scroll": {
                const result = (yield* call("scroll", { delta_x: input.delta_x ?? 0, delta_y: input.delta_y ?? 600 })) as {
                  url: string
                }
                tab.url = result.url
                return {
                  title: detail,
                  metadata: { action: input.action, url: result.url  } as Metadata,
                  output: `Scrolled (${input.delta_x ?? 0}, ${input.delta_y ?? 600}).`,
                }
              }
              case "evaluate": {
                const result = (yield* call("evaluate", { script: input.script })) as { url: string; result: unknown }
                tab.url = result.url
                let output = JSON.stringify(result.result ?? null, null, 2)
                if (output.length > MAX_EVALUATE_OUTPUT) {
                  output = `${output.slice(0, MAX_EVALUATE_OUTPUT)}… [truncated at 64KB]`
                }
                return {
                  title: detail,
                  metadata: { action: input.action, url: result.url  } as Metadata,
                  output,
                }
              }
              case "back": {
                const result = (yield* call("back", {})) as { url: string; navigated: boolean }
                tab.url = result.url
                return {
                  title: detail,
                  metadata: { action: input.action, url: result.url  } as Metadata,
                  output: result.navigated
                    ? `Went back to ${result.url}.`
                    : "No earlier page in history; the current page is unchanged.",
                }
              }
              case "close": {
                yield* request("close", {}, ctx.abort).pipe(Effect.orElseSucceed(() => undefined))
                kill()
                return {
                  title: detail,
                  metadata: { action: input.action  } as Metadata,
                  output: "Closed the browser tab. The next browser action will start a fresh browser.",
                }
              }
            }
          }).pipe(Effect.orDie),
        ),
    }
  }),
)
