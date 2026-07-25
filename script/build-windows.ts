// One-shot Windows desktop build, mirrors .github/workflows/desktop-windows.yml
// Usage:  bun ./script/build-windows.ts
//         OPENCODE_CHANNEL=beta bun ./script/build-windows.ts
import { $ } from "bun"
import path from "node:path"
import { fileURLToPath } from "node:url"

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const desktopDir = path.join(rootDir, "packages", "desktop")

// Match CI: every step runs with an explicit channel (default prod), never inherited.
const channel = process.env.OPENCODE_CHANNEL ?? "prod"
process.env.OPENCODE_CHANNEL = channel
process.env.RUST_TARGET = "x86_64-pc-windows-msvc"

console.log(`Building Windows desktop (channel=${channel})`)

$.cwd(desktopDir)
await $`bun ./scripts/prepare.ts`
await $`bun run build`
await $`npx electron-builder --win --publish never --config electron-builder.config.ts`

console.log(`Done. Artifacts in ${path.join(desktopDir, "dist")}`)
