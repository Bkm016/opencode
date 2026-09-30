/**
 * 模型在 markdown 里引用本地文件时写法五花八门：相对路径、绝对路径、file://、带 :行号 或 #L 行号。
 * 这里把 href 还原成文件路径；真正的网址（http、mailto 等）返回 undefined，交给外部浏览器。
 */

const EXTERNAL = /^(?:[a-z][a-z\d+.-]*:\/\/|\/\/|(?:mailto|tel|sms|magnet|data|javascript|blob):)/i
const DRIVE = /^[a-z]:[\\/]/i

export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"])

// 由模型给出的链接直接交给系统打开时可能被执行，这些类型只在文件管理器里定位
const EXECUTABLE_EXTENSIONS = new Set([
  "app",
  "bat",
  "cmd",
  "com",
  "command",
  "cpl",
  "desktop",
  "exe",
  "hta",
  "jar",
  "js",
  "jse",
  "lnk",
  "msc",
  "msi",
  "pif",
  "ps1",
  "reg",
  "scr",
  "sh",
  "url",
  "vbe",
  "vbs",
  "ws",
  "wsf",
])

export function filePathFromHref(href: string) {
  const raw = href.trim()
  if (!raw || raw.startsWith("#") || raw.startsWith("?")) return
  if (/^file:/i.test(raw)) return decode(fileUrlPath(raw))
  if (!DRIVE.test(raw) && EXTERNAL.test(raw)) return
  const path = decode(raw.replace(/[?#].*$/, "")).replace(/:\d+(?::\d+)?(?:-\d+)?$/, "")
  return path || undefined
}

export function isAbsoluteFilePath(path: string) {
  return path.startsWith("/") || path.startsWith("\\\\") || DRIVE.test(path)
}

/** 相对路径按工作区拼接并折叠 . 与 ..；绝对路径原样规范化。 */
export function resolveFilePath(directory: string, path: string) {
  // ~ 由服务端展开
  if (/^~(?:[\\/]|$)/.test(path)) return path
  const input = path
  const windows = DRIVE.test(directory) || DRIVE.test(input) || input.includes("\\")
  const sep = windows ? "\\" : "/"
  const joined = isAbsoluteFilePath(input) ? input : `${directory.replace(/[\\/]+$/, "")}/${input}`
  const drive = joined.match(DRIVE)?.[0].slice(0, 2)
  const parts: string[] = []
  for (const part of joined.slice(drive ? 2 : 0).split(/[\\/]+/)) {
    if (!part || part === ".") continue
    if (part === "..") parts.pop()
    else parts.push(part)
  }
  return `${drive ?? ""}${sep}${parts.join(sep)}`
}

export function fileExtension(path: string) {
  const name = path.split(/[\\/]/).pop() ?? ""
  const index = name.lastIndexOf(".")
  return index > 0 ? name.slice(index + 1).toLowerCase() : ""
}

export const isImagePath = (path: string) => IMAGE_EXTENSIONS.has(fileExtension(path))
export const isExecutablePath = (path: string) => EXECUTABLE_EXTENSIONS.has(fileExtension(path))

function fileUrlPath(raw: string) {
  const rest = raw.replace(/^file:(?:\/\/[^/]*)?/i, "").replace(/[?#].*$/, "")
  // file:///C:/x → C:/x
  return /^\/[a-z]:[\\/]/i.test(rest) ? rest.slice(1) : rest
}

function decode(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
