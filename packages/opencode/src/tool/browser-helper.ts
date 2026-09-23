// Browser helper child process: 独立 node 进程驱动浏览器，与宿主 Bun 运行时隔离。
// Bun 下 playwright-core 的 chromium.launch/connect 会因子进程管道兼容问题挂死，故浏览器生命周期全部放在 node 侧。
// 协议：stdin 逐行收 JSON 请求 { id, method, params }，stdout 逐行回 JSON { id, result } 或 { id, error }。
// 截图 base64 数据量大，直接放 result 字段随行返回；事件（crash/closed/disconnected）发 { event, params } 无 id。

import { createRequire } from "node:module"

// OPENCODE_BROWSER_HELPER_RESOLVE 指向宿主包内任意文件（通常为本 helper 源路径），
// 使 createRequire 从宿主依赖树解析 playwright-core，保证与宿主同版本。
const require2 = createRequire(process.env.OPENCODE_BROWSER_HELPER_RESOLVE ?? import.meta.url)
const { chromium } = require2("playwright-core") as typeof import("playwright-core")
const { registry } = require2("playwright-core/lib/server/registry/index") as {
  registry: {
    findExecutable(name: string): { executablePath?: () => string | undefined } | undefined
    // 下载并安装可执行文件到本机缓存；接受 findExecutable 返回的描述符。
    install(executables: unknown[]): Promise<void>
  }
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
// 同一 context 内的全部页面按不透明 tab id 寻址；页面失效只移除对应 id，
// 不得重建 context，否则其余 tab 的登录状态与 SPA 内存会一并丢失。
const pages = new Map<string, import("playwright-core").Page>()
let pageSequence = 0

function send(message: unknown) {
  process.stdout.write(JSON.stringify(message) + "\n")
}

function fail(id: number, error: unknown) {
  send({ id, error: error instanceof Error ? error.message : String(error) })
}

// 三级可执行文件回退：显式环境变量 > playwright 已下载缓存 > 系统 Chrome/Edge channel。
// 打包版 playwright-core 期望的 revision 可能与本机缓存不一致（dev 用仓库内另一份），
// 缓存缺失时先自动下载期望版本再重试，避免回退到几乎必然失败的 channel 解析。
async function launchOptions() {
  const headed = process.env.OPENCODE_BROWSER_HEADED === "1" || process.env.OPENCODE_BROWSER_HEADED === "true"
  const executable = process.env.OPENCODE_BROWSER_EXECUTABLE_PATH
  if (executable) return { executablePath: executable, headless: !headed }
  const preferred = headed ? ["chromium", "chromium-headless-shell"] : ["chromium-headless-shell", "chromium"]
  const { existsSync } = await import("node:fs")
  // executablePath() 恒返回按 revision 拼出的路径、不做存在性检查，故须自行 existsSync 校验缓存缺失。
  const lookup = () => {
    for (const name of preferred) {
      const descriptor = registry.findExecutable(name)
      const path = descriptor?.executablePath?.()
      if (descriptor && path && existsSync(path)) return { descriptor, path }
    }
    return undefined
  }
  const cached = lookup()
  if (cached) return { executablePath: cached.path, headless: !headed }
  // 缓存缺失：下载期望 revision（首个 preferred，即 headless 时的 chromium-headless-shell）后重查。
  const target = registry.findExecutable(preferred[0])
  if (target) {
    await registry.install([target])
    const installed = lookup()
    if (installed) return { executablePath: installed.path, headless: !headed }
  }
  return { channel: "chromium", headless: !headed }
}

// 登记一个 Page（主动创建或 window.open 弹窗），返回分配的 tab id。
function track(page: import("playwright-core").Page) {
  const tab = `tab-${++pageSequence}`
  page.setDefaultTimeout(ACTION_TIMEOUT)
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT)
  pages.set(tab, page)
  page.on("close", () => {
    if (pages.get(tab) !== page) return
    pages.delete(tab)
    send({ event: "closed", params: { tab } })
  })
  page.on("crash", () => send({ event: "crash", params: { tab } }))
  return tab
}

// 确保 browser/context 存活；浏览器断连才整组重建（单页失效不触发）。
async function ensureBrowser() {
  if (browser && browser.isConnected() && context) return context
  if (browser) await browser.close().catch(() => {})
  pages.clear()
  const options = await launchOptions()
  browser = await chromium.launch({ ...options, timeout: NAVIGATION_TIMEOUT })
  context = await browser.newContext({
    viewport: VIEWPORT,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
  })
  // 页面脚本 window.open 的弹窗同样登记，agent 可通过 tabs 发现并寻址。
  context.on("page", (page) => track(page))
  browser.on("disconnected", () => {
    send({ event: "disconnected" })
    browser = undefined
    context = undefined
    pages.clear()
  })
  return context
}

// 新建 tab；仅 navigate 路径允许创建页面，交互动作缺失页面时必须报错。
async function createPage() {
  const ctx = await ensureBrowser()
  const page = await ctx.newPage()
  // context.on("page") 与 newPage 的返回指向同一对象，重复登记会分配两个 id，须去重。
  for (const [tab, existing] of pages) {
    if (existing === page) return { tab, page }
  }
  return { tab: track(page), page }
}

// 按 params.tab 解析目标页面：缺省且唯一时直达；多页缺省或 id 失效均报错，不猜测、不自动创建。
function findPage(params: Record<string, unknown>) {
  const id = typeof params.tab === "string" && params.tab ? params.tab : undefined
  if (!id) {
    if (pages.size === 1) {
      const [tab, page] = pages.entries().next().value as [string, import("playwright-core").Page]
      return { tab, page }
    }
    if (pages.size === 0) throw new Error("No browser tab is open. Navigate to a URL first.")
    throw new Error("Multiple browser tabs are open. Specify tab; use tabs to list them.")
  }
  const page = pages.get(id)
  if (!page || page.isClosed()) throw new Error(`Browser tab "${id}" is unavailable. Use tabs to list open tabs.`)
  return { tab: id, page }
}

// 清理已被 closed 事件标记但尚未移除的 id；crash 事件保留 id 以使下一次操作报出明确错误。
function sweep() {
  for (const [tab, page] of [...pages]) {
    if (page.isClosed()) pages.delete(tab)
  }
}

const handlers: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
  async navigate(params) {
    if (params.new_tab === true && typeof params.tab === "string" && params.tab) {
      throw new Error("navigate accepts either tab or new_tab, not both.")
    }
    if (params.new_tab === true) {
      const { tab, page } = await createPage()
      const response = await page.goto(String(params.url), {
        waitUntil: (params.wait_until as "load" | "domcontentloaded" | "networkidle") ?? "load",
      })
      return { tab, url: page.url(), status: response?.status() ?? null, title: await page.title().catch(() => "") }
    }
    // 兼容单页旧调用：未指定 tab 且恰有一个页面时原地导航（会重置该页 SPA 状态）。
    const target =
      typeof params.tab === "string" && params.tab
        ? findPage(params)
        : pages.size === 1
          ? findPage(params)
          : await createPage()
    const response = await target.page.goto(String(params.url), {
      waitUntil: (params.wait_until as "load" | "domcontentloaded" | "networkidle") ?? "load",
    })
    return {
      tab: target.tab,
      url: target.page.url(),
      status: response?.status() ?? null,
      title: await target.page.title().catch(() => ""),
    }
  },
  async screenshot(params) {
    const { tab, page } = findPage(params)
    const buffer = await page.screenshot({ fullPage: params.full_page === true, type: "jpeg", quality: 85 })
    return { tab, url: page.url(), base64: buffer.toString("base64") }
  },
  async get_content(params) {
    const { tab, page } = findPage(params)
    if (typeof params.selector === "string" && params.selector) {
      const element = await page.$(params.selector)
      if (!element) throw new Error(`No element matches selector: ${params.selector}`)
      return { tab, url: page.url(), html: (await element.innerHTML()) ?? "" }
    }
    return { tab, url: page.url(), html: await page.content() }
  },
  async click(params) {
    const { tab, page } = findPage(params)
    await page.click(String(params.selector))
    return { tab, url: page.url() }
  },
  async type_text(params) {
    const { tab, page } = findPage(params)
    await page.fill(String(params.selector), String(params.text ?? ""))
    if (params.submit === true) await page.press(String(params.selector), "Enter")
    return { tab, url: page.url() }
  },
  async press_key(params) {
    const { tab, page } = findPage(params)
    await page.keyboard.press(String(params.key))
    return { tab, url: page.url() }
  },
  async scroll(params) {
    const { tab, page } = findPage(params)
    await page.mouse.wheel(Number(params.delta_x ?? 0), Number(params.delta_y ?? 600))
    return { tab, url: page.url() }
  },
  async evaluate(params) {
    const { tab, page } = findPage(params)
    const result = await page.evaluate(String(params.script))
    return { tab, url: page.url(), result: result ?? null }
  },
  async back(params) {
    const { tab, page } = findPage(params)
    const response = await page.goBack({ waitUntil: "load" })
    return { tab, url: page.url(), navigated: response !== null }
  },
  async current() {
    // 供宿主权限判定与 tabs 动作的页面快照；浏览器断连时视为无页面。
    sweep()
    if (!browser || !browser.isConnected()) return { tabs: [] }
    const list = await Promise.all(
      [...pages].map(async ([tab, page]) => ({
        tab,
        url: page.url(),
        title: await page.title().catch(() => ""),
      })),
    )
    return { tabs: list }
  },
  async close(params) {
    if (typeof params.tab === "string" && params.tab) {
      const page = pages.get(params.tab)
      if (!page || page.isClosed()) {
        throw new Error(`Browser tab "${params.tab}" is unavailable. Use tabs to list open tabs.`)
      }
      // close 事件负责移除 id 与上报，这里只关页面。
      await page.close()
      return { closed: true, tab: params.tab, all: false }
    }
    if (browser) await browser.close().catch(() => {})
    browser = undefined
    context = undefined
    pages.clear()
    return { closed: true, all: true }
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
