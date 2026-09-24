// Build a standalone Windows x64 opencode-server.exe that includes `opencode serve`.
// Usage: bun ./script/build-windows-server.ts
// Output: packages/opencode/dist/opencode-server-windows-x64/bin/opencode-server.exe
import { $ } from "bun"
import path from "node:path"
import { fileURLToPath } from "node:url"

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const opencodeDir = path.join(rootDir, "packages", "opencode")
const srcExe = path.join(opencodeDir, "dist", "opencode-windows-x64", "bin", "opencode.exe")
const dstDir = path.join(opencodeDir, "dist", "opencode-server-windows-x64", "bin")
const dstExe = path.join(dstDir, "opencode-server.exe")

$.cwd(opencodeDir)
await $`bun ./script/build.ts --os=win32 --arch=x64 --skip-embed-web-ui`

await $`mkdir -p ${dstDir}`
await $`mv -f ${srcExe} ${dstExe}`

console.log(`Done. Binary at ${dstExe}`)
console.log("Run: opencode-server.exe serve --hostname 0.0.0.0 --port 4096")
