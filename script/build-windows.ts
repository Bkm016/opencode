// One-shot Windows desktop build, mirrors .github/workflows/desktop-windows.yml
// Usage:  bun ./script/build-windows.ts
//         OPENCODE_CHANNEL=beta bun ./script/build-windows.ts
//         bun ./script/build-windows.ts --skip-sidecar   跳过 sidecar 重建（纯 UI 改动时省时）
import { $ } from "bun"
import path from "node:path"
import { fileURLToPath } from "node:url"

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const desktopDir = path.join(rootDir, "packages", "desktop")

// Match CI: every step runs with an explicit channel (default prod), never inherited.
const channel = process.env.OPENCODE_CHANNEL ?? "prod"
process.env.OPENCODE_CHANNEL = channel
process.env.RUST_TARGET = "x86_64-pc-windows-msvc"

// sidecar 由 prepare → prebuild 里的 build-node.ts 每次重建，纯前端改动时无意义。
// --skip-sidecar 跳过重编译，直接复用上一次 out/ 里的 sidecar 产物。
const skipSidecar = process.argv.includes("--skip-sidecar")

console.log(`Building Windows desktop (channel=${channel}, skipSidecar=${skipSidecar})`)

$.cwd(desktopDir)
if (skipSidecar) {
  // 仅同步版本号与资源，不重建 server sidecar；CLI 沿用上一次 prebuild 拷到 resources/cli/ 的产物。
  await $`bun ./scripts/copy-icons.ts ${channel}`
  await $`bun ./scripts/copy-metainfo.ts ${channel}`
  const pkg = await Bun.file("./package.json").json()
  const { Script } = await import("@opencode-ai/script")
  pkg.version = Script.version
  await Bun.write("./package.json", JSON.stringify(pkg, null, 2) + "\n")
} else {
  await $`bun ./scripts/prepare.ts`
}

// --skip-sidecar 时 resources/cli/opencode.exe 必须已经由上一次完整 build 拷好，
// 否则 electron-builder 的 extraResources 找不到文件直接失败。
const cliExe = path.join(desktopDir, "resources", "cli", "opencode.exe")
if (skipSidecar && !(await Bun.file(cliExe).exists())) {
  throw new Error(`${cliExe} missing — run without --skip-sidecar first`)
}
await $`bun run build`
await $`npx electron-builder --win --publish never --config electron-builder.config.ts`

// 打出的安装包会带 resources/cli/opencode.exe（完整 CLI，含 serve / skill cloud）。
console.log(`Done. Artifacts in ${path.join(desktopDir, "dist")}`)
