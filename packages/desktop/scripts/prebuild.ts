#!/usr/bin/env bun
import { $ } from "bun"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { resolveChannel, windowsify } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

await $`cd ../opencode && bun script/build-node.ts`

// 把完整 CLI（含 serve / skill cloud 等 fork 私有指令）打进安装包，
// 用户装完可在 resources/cli/opencode.exe 直接调用。
if (process.platform === "win32") {
  // --skip-install：build.ts 默认每次跑 bun install --os="*" --cpu="*" 拉全平台依赖，
  // 本地反复构建时 ghostty-web 等 github tarball 常因网络/EPERM 挂掉；node_modules 已在就直接复用。
  await $`cd ../opencode && bun script/build.ts --os=win32 --arch=x64 --skip-embed-web-ui --skip-install`
  const src = "../opencode/dist/opencode-windows-x64/bin/opencode.exe"
  const dest = windowsify("resources/cli/opencode")
  await $`mkdir -p resources/cli`
  await $`cp ${src} ${dest}`

  // bun --compile 产物默认是 Bun 包子图标，用 rcedit 把 opencode 图标写进 exe 资源。
  // electron-winstaller 是 desktop 的间接依赖，直接到 node_modules/.bun 下找 vendor/rcedit.exe。
  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  const desktopDir = path.resolve(scriptDir, "..")
  const rootDir = path.resolve(desktopDir, "../..")
  const rcedit = (
    await Array.fromAsync(
      new Bun.Glob("electron-winstaller@*/node_modules/electron-winstaller/vendor/rcedit.exe").scan({
        cwd: path.join(rootDir, "node_modules", ".bun"),
        absolute: true,
      }),
    )
  )[0]
  if (!rcedit) throw new Error("rcedit.exe not found under node_modules/.bun/electron-winstaller-*")
  const icon = path.resolve(desktopDir, `icons/${channel}/icon.ico`)
  await $`"${rcedit}" "${dest}" --set-icon "${icon}"`

  console.log(`Copied CLI to ${dest} with icon`)
}
