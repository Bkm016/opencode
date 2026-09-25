// Build a standalone Windows x64 opencode.exe CLI that includes `opencode serve`
// and fork-only commands like `opencode skill cloud`. Embeds the full web UI so
// `opencode serve` serves the desktop-grade frontend, not the bare fallback.
// Usage: bun ./script/build-windows-server.ts
// Output: packages/opencode/dist/opencode-cli-windows-x64/opencode.exe (+ .zip 便于分发)
import { $ } from "bun"
import path from "node:path"
import { fileURLToPath } from "node:url"

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const opencodeDir = path.join(rootDir, "packages", "opencode")
const distDir = path.join(opencodeDir, "dist")
const srcExe = path.join(distDir, "opencode-windows-x64", "bin", "opencode.exe")
const outDir = path.join(distDir, "opencode-cli-windows-x64")
const outExe = path.join(outDir, "opencode.exe")
const outZip = path.join(distDir, "opencode-cli-windows-x64.zip")

// release channel 让 UI 不显示 DEV/beta 角标
process.env.OPENCODE_CHANNEL = process.env.OPENCODE_CHANNEL ?? "latest"
process.env.OPENCODE_RELEASE = process.env.OPENCODE_RELEASE ?? "1"

$.cwd(opencodeDir)
await $`bun ./script/build.ts --os=win32 --arch=x64`

await $`mkdir -p ${outDir}`
await $`cp -f ${srcExe} ${outExe}`

// 打成 zip 方便直接发给别人，解压即用；PowerShell 的 Expand-Archive 可解。
await $`rm -f ${outZip}`
await $`zip -j ${outZip} ${outExe}`

console.log(`Done.`)
console.log(`  exe: ${outExe}`)
console.log(`  zip: ${outZip}`)
console.log("Run: opencode.exe serve --hostname 0.0.0.0 --port 4096")
