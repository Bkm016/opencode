#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")
const outFile = path.join(dir, "dist/node/node.js")

process.chdir(dir)

if (process.env.OPENCODE_FORCE_NODE_BUILD !== "1" && isFreshBuild()) {
  console.log("Build skipped (dist/node is up to date)")
  process.exit(0)
}

const generated = await import("./generate.ts")
const sourcemap = process.env.OPENCODE_NODE_SOURCEMAP === "1" ? "linked" : "none"

await Bun.build({
  target: "node",
  entrypoints: ["./src/node.ts"],
  outdir: "./dist/node",
  format: "esm",
  // Linked maps double disk I/O (~50MB) and are rarely needed for the desktop sidecar.
  sourcemap,
  // jsonc-parser stays external: its UMD entry uses require("./impl/*") and
  // does not bundle cleanly. Desktop copies the package next to the sidecar.
  external: ["jsonc-parser", "@lydell/node-pty"],
  define: {
    OPENCODE_MODELS_DEV: generated.modelsData,
    OPENCODE_CHANNEL: `'${Script.channel}'`,
  },
  files: {
    "opencode-web-ui.gen.ts": "",
  },
})

if (sourcemap === "none") {
  const map = path.join(dir, "dist/node/node.js.map")
  if (fs.existsSync(map)) fs.unlinkSync(map)
}

console.log("Build complete")

function isFreshBuild() {
  if (!fs.existsSync(outFile)) return false
  const outMtime = fs.statSync(outFile).mtimeMs
  const roots = [path.join(dir, "src"), path.join(dir, "script"), path.join(dir, "package.json")]
  for (const root of roots) {
    if (newestMtime(root) > outMtime) return false
  }
  return true
}

function newestMtime(target: string): number {
  if (!fs.existsSync(target)) return 0
  const stat = fs.statSync(target)
  if (!stat.isDirectory()) return stat.mtimeMs
  let newest = stat.mtimeMs
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".cache") continue
    const child = newestMtime(path.join(target, entry.name))
    if (child > newest) newest = child
  }
  return newest
}
