import { spawn, spawnSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { cmd } from "./cmd"

// CI 每次推送都把产物覆盖到 latest 这个 Release；OPENCODE_UPDATE_URL 只用于测试时指向别的地址
const BASE = process.env.OPENCODE_UPDATE_URL ?? "https://github.com/Bkm016/opencode/releases/download/latest"
const ASSET = "opencode-linux-x64-baseline.tar.gz"
const SERVER_COMMANDS = new Set(["serve", "web"])

// 版本号形如 1.18.3-dev-20261002025428（提交时间），本地构建可能只到分钟，补齐后按数字比较
function stamp(version: string) {
  const match = /(\d{12,14})$/.exec(version)
  if (!match) return 0
  return Number(match[1].padEnd(14, "0"))
}

async function latestVersion() {
  const res = await fetch(`${BASE}/latest.yml`, { redirect: "follow" })
  if (!res.ok) throw new Error(`读取版本信息失败：HTTP ${res.status}`)
  const version = /^version:\s*(\S+)/m.exec(await res.text())?.[1]
  if (!version) throw new Error("版本信息里没有 version 字段")
  return version
}

async function download(dir: string) {
  const res = await fetch(`${BASE}/${ASSET}`, { redirect: "follow" })
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`)
  const archive = path.join(dir, ASSET)
  // Bun.write 直接写 Response 在跟随重定向的下载上会卡住，先读完再写
  fs.writeFileSync(archive, new Uint8Array(await res.arrayBuffer()))
  const tar = spawnSync("tar", ["-xzf", archive, "-C", dir], { encoding: "utf8" })
  if (tar.status !== 0) throw new Error(`解压失败：${tar.stderr || tar.error?.message}`)
  const binary = path.join(dir, "opencode")
  if (!fs.existsSync(binary)) throw new Error("压缩包里没有 opencode 可执行文件")
  fs.chmodSync(binary, 0o755)
  return binary
}

type Running = {
  pid: number
  argv: string[]
  cwd: string
  env: Record<string, string>
  output?: string
  uid: number
  gid: number
  unit?: { name: string; user: boolean }
}

// 找出用这个可执行文件跑着的 serve/web 进程；替换文件后旧进程的 exe 链接会带上 " (deleted)"
function runningServers(target: string): Running[] {
  const result: Running[] = []
  for (const entry of fs.readdirSync("/proc")) {
    const pid = Number(entry)
    if (!Number.isInteger(pid) || pid === process.pid) continue
    try {
      const exe = fs.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, "")
      if (exe !== target) continue
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean)
      if (!SERVER_COMMANDS.has(argv[1] ?? "")) continue
      const env = Object.fromEntries(
        fs
          .readFileSync(`/proc/${pid}/environ`, "utf8")
          .split("\0")
          .filter(Boolean)
          .map((line) => {
            const index = line.indexOf("=")
            return [line.slice(0, index), line.slice(index + 1)]
          }),
      )
      const output = (() => {
        try {
          const file = fs.readlinkSync(`/proc/${pid}/fd/1`)
          return file.startsWith("/") && fs.statSync(file).isFile() ? file : undefined
        } catch {
          return undefined
        }
      })()
      const status = fs.readFileSync(`/proc/${pid}/status`, "utf8")
      const id = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(status)?.[1] ?? -1)
      result.push({
        pid,
        argv,
        cwd: fs.readlinkSync(`/proc/${pid}/cwd`),
        env,
        output,
        uid: id("Uid"),
        gid: id("Gid"),
        unit: systemdUnit(pid),
      })
    } catch {
      continue
    }
  }
  return result
}

function systemdUnit(pid: number) {
  try {
    const cgroup = fs.readFileSync(`/proc/${pid}/cgroup`, "utf8")
    const segments = cgroup.trim().split("\n").at(-1)?.split(":").at(-1)?.split("/") ?? []
    const name = segments.at(-1)
    if (!name?.endsWith(".service") || /^user@\d+\.service$/.test(name)) return undefined
    return { name, user: segments.some((segment) => /^user@\d+\.service$/.test(segment)) }
  } catch {
    return undefined
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function stop(pid: number) {
  process.kill(pid, "SIGTERM")
  for (let i = 0; i < 100 && alive(pid); i++) await Bun.sleep(100)
  if (alive(pid)) process.kill(pid, "SIGKILL")
  for (let i = 0; i < 20 && alive(pid); i++) await Bun.sleep(100)
}

async function restart(target: string, server: Running) {
  const label = `${server.argv.slice(1).join(" ")}（pid ${server.pid}）`
  if (server.unit) {
    const args = [...(server.unit.user ? ["--user"] : []), "restart", server.unit.name]
    const res = spawnSync("systemctl", args, { encoding: "utf8" })
    if (res.status === 0) return console.log(`已重启 systemd 服务 ${server.unit.name}`)
    return console.log(`重启 ${server.unit.name} 失败，请手动执行：sudo systemctl ${args.join(" ")}`)
  }
  await stop(server.pid)
  const out = server.output ? fs.openSync(server.output, "a") : "ignore"
  const child = spawn(target, server.argv.slice(1), {
    cwd: server.cwd,
    env: server.env,
    detached: true,
    // 用 sudo 更新时按原来的用户重启，不能把服务变成 root 跑
    ...(process.getuid?.() === 0 && server.uid >= 0 ? { uid: server.uid, gid: server.gid } : {}),
    stdio: ["ignore", out, out],
  })
  child.unref()
  await Bun.sleep(1500)
  if (child.pid && alive(child.pid)) return console.log(`已重启 ${label} → 新 pid ${child.pid}`)
  console.log(`重启 ${label} 失败，请手动启动：${target} ${server.argv.slice(1).join(" ")}`)
}

export const UpdateCommand = cmd({
  command: "update",
  describe: "update opencode to the latest build and restart running servers",
  builder: (yargs) =>
    yargs
      .option("check", { type: "boolean", describe: "only check for a new version" })
      .option("force", { type: "boolean", describe: "reinstall even if already up to date" })
      .option("restart", { type: "boolean", default: true, describe: "restart running opencode serve/web" }),
  async handler(args) {
    if (process.platform !== "linux" || process.arch !== "x64") {
      console.error("opencode update 目前只支持 Linux x64，其他平台请用桌面端自动更新")
      process.exitCode = 1
      return
    }
    const target = fs.realpathSync(process.execPath)
    if (path.basename(target).startsWith("bun")) {
      console.error("当前是从源码运行的，不能自更新")
      process.exitCode = 1
      return
    }

    const latest = await latestVersion()
    const current = InstallationVersion
    const newer = stamp(latest) > stamp(current)
    console.log(`当前版本 ${current}，最新版本 ${latest}`)
    if (!newer && !args.force) return console.log("已经是最新版本")
    if (args.check) return console.log("有新版本，执行 opencode update 更新")

    try {
      fs.accessSync(path.dirname(target), fs.constants.W_OK)
    } catch {
      console.error(`没有权限写入 ${path.dirname(target)}，请用 sudo opencode update`)
      process.exitCode = 1
      return
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-update-"))
    try {
      console.log("正在下载…")
      const binary = await download(dir)
      const check = spawnSync(binary, ["--version"], { encoding: "utf8" })
      if (check.status !== 0) throw new Error(`新版本无法运行：${check.stderr || check.error?.message}`)
      if (check.stdout.trim() !== latest) console.log(`注意：下载到的版本是 ${check.stdout.trim()}`)

      // 先拷到同目录再改名覆盖：改名是原子的，正在跑的旧进程不受影响
      const staged = `${target}.update`
      fs.copyFileSync(binary, staged)
      fs.chmodSync(staged, 0o755)
      fs.renameSync(staged, target)
      console.log(`已更新到 ${check.stdout.trim()}（${target}）`)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }

    const servers = runningServers(target)
    if (servers.length === 0) return
    if (!args.restart) {
      console.log(`有 ${servers.length} 个 opencode 服务还在跑旧版本，重启后生效`)
      return
    }
    for (const server of servers) await restart(target, server)
  },
})
