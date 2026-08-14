export * as Shell from "./shell"

import path from "path"
import { spawn, type ChildProcess } from "child_process"
import { readFile } from "fs/promises"
import { statSync } from "fs"
import { setTimeout as sleep } from "node:timers/promises"
import { Flag } from "./flag/flag"
import { FSUtil } from "./fs-util"
import { which } from "./util/which"
import { mkdirSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { createHash } from "crypto"

const SIGKILL_TIMEOUT_MS = 200
const META: Record<string, { deny?: boolean; login?: boolean; posix?: boolean; ps?: boolean }> = {
  bash: { login: true, posix: true },
  dash: { login: true, posix: true },
  fish: { deny: true, login: true },
  ksh: { login: true, posix: true },
  nu: { deny: true },
  powershell: { ps: true },
  pwsh: { ps: true },
  sh: { login: true, posix: true },
  zsh: { login: true, posix: true },
}

export type Item = {
  path: string
  name: string
  acceptable: boolean
}

export async function killTree(proc: ChildProcess, opts?: { exited?: () => boolean }): Promise<void> {
  const pid = proc.pid
  if (!pid || opts?.exited?.()) return

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/f", "/t"], {
        stdio: "ignore",
        windowsHide: true,
      })
      killer.once("exit", () => resolve())
      killer.once("error", () => resolve())
    })
    return
  }

  try {
    process.kill(-pid, "SIGTERM")
    await sleep(SIGKILL_TIMEOUT_MS)
    if (!opts?.exited?.()) {
      process.kill(-pid, "SIGKILL")
    }
  } catch {
    proc.kill("SIGTERM")
    await sleep(SIGKILL_TIMEOUT_MS)
    if (!opts?.exited?.()) {
      proc.kill("SIGKILL")
    }
  }
}

function stat(file: string) {
  return statSync(file, { throwIfNoEntry: false }) ?? undefined
}

function full(file: string) {
  if (process.platform !== "win32") return file
  const shell = FSUtil.windowsPath(file)
  if (path.win32.dirname(shell) !== ".") {
    if (shell.startsWith("/") && name(shell) === "bash") return gitbash() || shell
    return shell
  }
  if (name(shell) === "bash") return gitbash() || which(shell) || shell
  return which(shell) || shell
}

function meta(file: string) {
  return META[name(file)]
}

function ok(file: string) {
  return meta(file)?.deny !== true
}

function rooted(file: string) {
  return path.isAbsolute(FSUtil.windowsPath(file))
}

function resolve(file: string) {
  const shell = full(file)
  if (rooted(shell)) {
    if (stat(shell)?.isFile()) return shell
    return
  }
  return which(shell) ?? undefined
}

function win() {
  return Array.from(
    new Set(
      [which("pwsh"), which("powershell"), gitbash(), process.env.COMSPEC || "cmd.exe"]
        .filter((item): item is string => Boolean(item))
        .map(full),
    ),
  )
}

async function unix() {
  const text = await readFile("/etc/shells", "utf8").catch(() => "")
  if (text) return Array.from(new Set(text.split("\n").filter((line) => line.trim() && !line.startsWith("#"))))
  return ["/bin/bash", "/bin/zsh", "/bin/sh"]
}

function select(file: string | undefined, opts?: { acceptable?: boolean }) {
  if (file && (!opts?.acceptable || ok(file))) {
    const shell = resolve(file)
    if (shell) return shell
  }
  if (process.platform === "win32") return win()[0]
  return fallback()
}

export function gitbash() {
  if (process.platform !== "win32") return
  if (Flag.OPENCODE_GIT_BASH_PATH) return Flag.OPENCODE_GIT_BASH_PATH
  const git = which("git")
  if (!git) return
  const file = path.join(git, "..", "..", "bin", "bash.exe")
  if (stat(file)?.size) return file
}

function fallback() {
  if (process.platform === "darwin") return "/bin/zsh"
  const bash = which("bash")
  if (bash) return bash
  return "/bin/sh"
}

export function name(file: string) {
  if (process.platform === "win32") return path.win32.parse(FSUtil.windowsPath(file)).name.toLowerCase()
  return path.basename(file).toLowerCase()
}

export function login(file: string) {
  return meta(file)?.login === true
}

export function posix(file: string) {
  return meta(file)?.posix === true
}

export function ps(file: string) {
  return meta(file)?.ps === true
}

function info(file: string): Item {
  const item = full(file)
  const n = name(item)
  return {
    path: item,
    name: resolve(n) ? n : item,
    acceptable: ok(item),
  }
}

export function args(file: string, command: string, cwd: string) {
  const n = name(file)
  if (n === "nu" || n === "fish") return ["-c", command]
  if (n === "zsh") {
    return [
      "-l",
      "-c",
      `
        [[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
        [[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true
        cd -- "$1"
        eval ${JSON.stringify(command)}
      `,
      "opencode",
      cwd,
    ]
  }
  if (n === "bash") {
    return [
      "-l",
      "-c",
      `
        shopt -s expand_aliases
        [[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true
        cd -- "$1"
        eval ${JSON.stringify(command)}
      `,
      "opencode",
      cwd,
    ]
  }
  if (n === "cmd") return ["/c", command]
  if (ps(file)) return psArgs(command)
  return ["-c", command]
}

/** Spawn target for running `command` in `file` (bin + argv). */
export function launch(file: string, command: string, cwd: string): { command: string; args: string[] } {
  if (process.platform === "win32" && ps(file)) {
    // 写入带 BOM 的 UTF-8 临时脚本并用 -File 执行：-EncodedCommand 在 Windows PowerShell 5.1 下
    // 会先走 ANSI 命令行解码，CJK 脚本内容会被破坏（如“开发”→“闂l讲”）。脚本文件以 BOM 标记
    // 强制 5.1 按 UTF-8 解析，从而彻底绕开 ANSI CreateProcess 命令行编码。
    const script = writeUtf8Script(command)
    const shell = /[\s"]/.test(file) ? `"${file.replaceAll('"', "")}"` : file
    // 脚本路径无空格（opencode-ps\<hex>.ps1），-File 不加引号——cmd 的 & 拆词会把
    // 引号当字面字符传给 -File，导致 "Illegal characters in path"。
    return {
      command: process.env.COMSPEC || "cmd.exe",
      args: ["/d", "/c", `chcp 65001>nul & ${shell} -NoLogo -NoProfile -NonInteractive -File ${script}`],
    }
  }
  return { command: file, args: args(file, command, cwd) }
}

/** Write `command` to a UTF-8-BOM .ps1 temp file and return its path. 内容哈希命名可复用，避免每次堆积临时目录。 */
function writeUtf8Script(command: string): string {
  const dir = path.join(tmpdir(), "opencode-ps")
  mkdirSync(dir, { recursive: true })
  const body = psBody(command)
  const name = createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16) + ".ps1"
  const file = path.join(dir, name)
  writeFileSync(file, "\uFEFF" + body, { encoding: "utf8" })
  return file
}

function psBody(command: string) {
  if (process.platform !== "win32") return command
  // PSDefaultParameterValues 强制 Get-Content 等 cmdlet 默认按 UTF-8 解码文本文件；
  // 5.1 原生默认是系统 ANSI，直接读取 UTF-8 无 BOM 文件会得到"寮€鍙"类 GBK 乱码。
  return `[Console]::InputEncoding = [Console]::OutputEncoding = $OutputEncoding = [System.Text.UTF8Encoding]::new($false); $PSDefaultParameterValues['*:Encoding'] = 'utf8'; ${command}`
}

function psArgs(command: string) {
  if (process.platform !== "win32") {
    return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]
  }
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(psBody(command), "utf16le").toString("base64"),
  ]
}

const CLIXML_START = "#< CLIXML"
const CLIXML_OBJS = "<Objs"
const CLIXML_END = "</Objs>"
const CLIXML_ERROR = /<S S="Error">([\s\S]*?)<\/S>/g

function decodeClixml(text: string) {
  return text
    .replaceAll("_x000D_", "\r")
    .replaceAll("_x000A_", "\n")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
}

/** Flatten PowerShell CLIXML stderr into plain text for model/UI display. */
export function plain(output: string) {
  if (!output.includes(CLIXML_START) && !output.includes(CLIXML_OBJS)) return output

  let result = ""
  let rest = output
  while (rest.length > 0) {
    const marker = rest.indexOf(CLIXML_START)
    const objs = rest.indexOf(CLIXML_OBJS)
    const start =
      marker >= 0 && objs >= 0 ? Math.min(marker, objs) : marker >= 0 ? marker : objs >= 0 ? objs : -1
    if (start < 0) {
      result += rest
      break
    }

    result += rest.slice(0, start)
    let after = rest.slice(start)

    // Keep stdout that arrived between the CLIXML banner and the XML body.
    if (after.startsWith(CLIXML_START)) {
      after = after.slice(CLIXML_START.length).replace(/^\r?\n/, "")
      const xmlAt = after.indexOf(CLIXML_OBJS)
      if (xmlAt < 0) {
        // Incomplete stream: drop the banner, keep the rest for later chunks.
        result += after
        break
      }
      result += after.slice(0, xmlAt)
      after = after.slice(xmlAt)
    }

    if (!after.startsWith(CLIXML_OBJS)) {
      const xmlAt = after.indexOf(CLIXML_OBJS)
      if (xmlAt < 0) {
        result += after
        break
      }
      result += after.slice(0, xmlAt)
      after = after.slice(xmlAt)
    }

    const end = after.indexOf(CLIXML_END)
    if (end < 0) break

    const xml = after.slice(0, end + CLIXML_END.length)
    const errors: string[] = []
    for (const match of xml.matchAll(CLIXML_ERROR)) {
      if (match[1]) errors.push(decodeClixml(match[1]))
    }
    if (errors.length > 0) {
      result += errors.join("").replace(/\n+$/, "") + "\n"
    }
    rest = after.slice(end + CLIXML_END.length)
  }

  return result
}

let defaultPreferred: string | undefined
let defaultAcceptable: string | undefined

export function preferred(configShell?: string) {
  if (configShell) return select(configShell)
  defaultPreferred ??= select(process.env.SHELL)
  return defaultPreferred
}
preferred.reset = () => {
  defaultPreferred = undefined
}

export function acceptable(configShell?: string) {
  if (configShell) return select(configShell, { acceptable: true })
  defaultAcceptable ??= select(process.env.SHELL, { acceptable: true })
  return defaultAcceptable
}
acceptable.reset = () => {
  defaultAcceptable = undefined
}

export async function list(): Promise<Item[]> {
  const shells = process.platform === "win32" ? win() : await unix()
  return shells.filter((s) => resolve(s)).map(info)
}
