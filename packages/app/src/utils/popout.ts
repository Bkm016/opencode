// 会话独立窗口：窗口打开时带 ?popout=1，只显示这一个会话（不显示侧栏和项目导航）。
// 在窗口内跳转会丢掉查询参数，所以加载时读一次并存进 sessionStorage，刷新后仍保持精简布局。
const KEY = "opencode.popout"

function detect() {
  if (typeof window === "undefined") return false
  try {
    if (new URLSearchParams(window.location.search).get("popout") === "1") {
      window.sessionStorage.setItem(KEY, "1")
      return true
    }
    return window.sessionStorage.getItem(KEY) === "1"
  } catch {
    return false
  }
}

const popout = detect()

export function isPopout() {
  return popout
}

/** 在独立窗口打开会话；桌面版交给主进程建窗口，浏览器用 window.open 兜底。 */
export function openSessionWindow(platform: { openSessionWindow?(href: string): Promise<void> | void }, href: string) {
  if (platform.openSessionWindow) return void platform.openSessionWindow(href)
  const url = new URL(href, window.location.origin)
  url.searchParams.set("popout", "1")
  window.open(url.toString(), "_blank", "popup,width=960,height=800")
}
