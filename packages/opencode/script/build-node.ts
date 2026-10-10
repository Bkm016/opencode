#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import { $ } from "bun"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { isFresh } from "./fresh"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")
const outFile = path.join(dir, "dist/node/node.js")

process.chdir(dir)

if (process.env.OPENCODE_FORCE_NODE_BUILD !== "1" && isFresh(outFile)) {
  console.log("Build skipped (dist/node is up to date)")
  process.exit(0)
}

const sourcemap = process.env.OPENCODE_NODE_SOURCEMAP === "1" ? "linked" : "none"

// 内置 Web UI：浏览器直接访问桌面版 sidecar 端口时用的是本仓库的前端，而不是转发官方线上版。
// node 产物不能像单文件二进制那样把文件编进 $bunfs，这里把 app/dist 拷到 dist/node/web，
// 映射表在运行时按 node.js 所在目录解析，打进 asar 后照样能读。
const createWebUI = async () => {
  const appDir = path.resolve(dir, "../app")
  const dist = path.join(appDir, "dist")
  const web = path.join(dir, "dist/node/web")
  await $`OPENCODE_CHANNEL=${Script.channel} bun run --cwd ${appDir} build`
  const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dist })))
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.endsWith(".map"))
    .sort()
  fs.rmSync(web, { recursive: true, force: true })
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(web, file)), { recursive: true })
    fs.copyFileSync(path.join(dist, file), path.join(web, file))
  }
  return [
    `import path from "node:path"`,
    `import { fileURLToPath } from "node:url"`,
    `const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "web")`,
    `const files = ${JSON.stringify(files)}`,
    `export default Object.fromEntries(files.map((file) => [file, path.join(dir, ...file.split("/"))]))`,
  ].join("\n")
}

const webUI = process.argv.includes("--skip-embed-web-ui") ? "" : await createWebUI()

await Bun.build({
  target: "node",
  entrypoints: ["./src/node.ts", "./src/tool/browser-helper.ts"],
  outdir: "./dist/node",
  naming: "[name].js",
  format: "esm",
  // Linked maps double disk I/O (~50MB) and are rarely needed for the desktop sidecar.
  sourcemap,
  // jsonc-parser stays external: its UMD entry uses require("./impl/*") and
  // does not bundle cleanly. Desktop copies the package next to the sidecar.
  // playwright-core stays external: the browser helper spawns a separate node
  // process and resolves it from the sidecar node_modules at runtime.
  external: ["jsonc-parser", "@lydell/node-pty", "playwright-core"],
  define: {
    // Zen 免费模型按 User-Agent 里的版本号校验来源，缺了版本号会发成 opencode/local 被拒。
    OPENCODE_VERSION: `'${Script.version}'`,
    OPENCODE_CHANNEL: `'${Script.channel}'`,
  },
  files: {
    "opencode-web-ui.gen.ts": webUI,
    // 桌面 sidecar 使用同目录的 browser-helper.mjs，不内嵌 helper。
    "opencode-browser-helper.gen.ts": "",
  },
})

// browser helper 由独立 node 子进程 spawn，脱离 package.json 上下文，须带 .mjs 扩展按 ESM 加载。
const helper = path.join(dir, "dist/node/browser-helper.js")
if (fs.existsSync(helper)) fs.renameSync(helper, path.join(dir, "dist/node/browser-helper.mjs"))

if (sourcemap === "none") {
  const map = path.join(dir, "dist/node/node.js.map")
  if (fs.existsSync(map)) fs.unlinkSync(map)
}

console.log("Build complete")
