// Browser helper child process: 独立 node 进程驱动浏览器，与宿主 Bun 运行时隔离。
// Bun 下 playwright-core 的 chromium.launch/connect 会因子进程管道兼容问题挂死，故浏览器生命周期全部放在 node 侧。
// 协议：stdin 逐行收 JSON 请求 { id, method, params }，stdout 逐行回 JSON { id, result } 或 { id, error }。
// 截图 base64 数据量大，直接放 result 字段随行返回；事件（crash/disconnected）发 { event, params } 无 id。

import { createRequire } from "node:module"

// OPENCODE_BROWSER_HELPER_RESOLVE 指向宿主包内任意文件（通常为本 helper 源路径），
// 使 createRequire 从宿主依赖树解析 playwright-core，保证与宿主同版本。
const require2 = createRequire(process.env.OPENCODE_BROWSER_HELPER_RESOLVE ?? import.meta.url)
const { chromium } = require2("playwright-core") as typeof import("playwright-core")
const { registry } = require2("playwright-core/lib/server/registry/index") as {
  registry: { findExecutable(name: string): { executablePath?: () => string | undefined } | undefined }
}

interface Request {
  id: number
  method: string
  params: Record<string, unknown>
}

const NAVIGATION_TIMEOUT = 30_000
const ACTION_TIMEOUT = 15_000
const VIEWPORT = { width: 1280, height: 800 }

let browser: import("playwright-core").Browser | undefined
let context: import("playwright-core").BrowserContext | undefined
let page: import("playwright-core").Page | undefined

function send(message: unknown) {
  process.stdout.write(JSON.stringify(message) + "\n")
}

function fail(id: number, error: unknown) {
  send({ id, error: error instanceof Error ? error.message : String(error) })
}

// 三级可执行文件回退：显式环境变量 > playwright 已下载缓存 > 系统 Chrome/Edge channel。
async function launchOptions() {
  const headed = process.env.OPENCODE_BROWSER_HEADED === "1" || process.env.OPENCODE_BROWSER_HEADED === "true"
  const executable = process.env.OPENCODE_BROWSER_EXECUTABLE_PATH
  if (executable) return { executablePath: executable, headless: !headed }
  const preferred = headed ? ["chromium", "chromium-headless-shell"] : ["chromium-headless-shell", "chromium"]
  for (const name of preferred) {
    const path = registry.findExecutable(name)?.executablePath?.()
    if (path) return { executablePath: path, headless: !headed }
  }
  return { channel: "chromium", headless: !headed }
}

async function ensurePage() {
  if (browser && browser.isConnected() && page && !page.isClosed()) return page
  if (browser) await browser.close().catch(() => {})
  const options = await launchOptions()
  browser = await chromium.launch({ ...options, timeout: NAVIGATION_TIMEOUT })
  context = await browser.newContext({
    viewport: VIEWPORT,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
  })
  page = await context.newPage()
  page.setDefaultTimeout(ACTION_TIMEOUT)
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT)
  page.on("crash", () => send({ event: "crash" }))
  browser.on("disconnected", () => {
    send({ event: "disconnected" })
    browser = undefined
    page = undefined
  })
  return page
}

const handlers: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
  async navigate(params) {
    const p = await ensurePage()
    const response = await p.goto(String(params.url), {
      waitUntil: (params.wait_until as "load" | "domcontentloaded" | "networkidle") ?? "load",
    })
    return { url: p.url(), status: response?.status() ?? null, title: await p.title().catch(() => "") }
  },
  async screenshot(params) {
    const p = await ensurePage()
    const buffer = await p.screenshot({ fullPage: params.full_page === true, type: "jpeg", quality: 85 })
    return { url: p.url(), base64: buffer.toString("base64") }
  },
  async get_content(params) {
    const p = await ensurePage()
    if (typeof params.selector === "string" && params.selector) {
      const element = await p.$(params.selector)
      if (!element) throw new Error(`No element matches selector: ${params.selector}`)
      return { url: p.url(), html: (await element.innerHTML()) ?? "" }
    }
    return { url: p.url(), html: await p.content() }
  },
  async click(params) {
    const p = await ensurePage()
    await p.click(String(params.selector))
    return { url: p.url() }
  },
  async type_text(params) {
    const p = await ensurePage()
    await p.fill(String(params.selector), String(params.text ?? ""))
    if (params.submit === true) await p.press(String(params.selector), "Enter")
    return { url: p.url() }
  },
  async press_key(params) {
    const p = await ensurePage()
    await p.keyboard.press(String(params.key))
    return { url: p.url() }
  },
  async scroll(params) {
    const p = await ensurePage()
    await p.mouse.wheel(Number(params.delta_x ?? 0), Number(params.delta_y ?? 600))
    return { url: p.url() }
  },
  async evaluate(params) {
    const p = await ensurePage()
    const result = await p.evaluate(String(params.script))
    return { url: p.url(), result: result ?? null }
  },
  async back() {
    const p = await ensurePage()
    const response = await p.goBack({ waitUntil: "load" })
    return { url: p.url(), navigated: response !== null }
  },
  async current() {
    if (!browser || !browser.isConnected() || !page || page.isClosed()) return { open: false }
    return { open: true, url: page.url() }
  },
  async close() {
    if (browser) await browser.close().catch(() => {})
    browser = undefined
    page = undefined
    return { closed: true }
  },
}

let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  for (;;) {
    const newline = buffer.indexOf("\n")
    if (newline < 0) break
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (!line) continue
    let request: Request
    try {
      request = JSON.parse(line)
    } catch {
      continue
    }
    const handler = handlers[request.method]
    if (!handler) {
      fail(request.id, `Unknown browser helper method: ${request.method}`)
      continue
    }
    handler(request.params ?? {}).then(
      (result) => send({ id: request.id, result }),
      (error) => fail(request.id, error),
    )
  }
})

// 宿主退出时 stdin 断开，立即退出避免孤儿浏览器进程。
process.stdin.on("end", () => {
  void browser?.close().catch(() => {})
  process.exit(0)
})
process.on("disconnect", () => process.exit(0))
