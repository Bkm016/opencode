#!/usr/bin/env bun
import { $ } from "bun"
import { existsSync } from "node:fs"
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
  // electron-winstaller 是 desktop 的间接依赖。本地 bun isolated install 落在
  // node_modules/.bun，CI hoisted install 直接落在 node_modules，两处都找一遍。
  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  const desktopDir = path.resolve(scriptDir, "..")
  const rootDir = path.resolve(desktopDir, "../..")
  const bunDir = path.join(rootDir, "node_modules", ".bun")
  const rceditCandidates: string[] = []
  if (existsSync(bunDir)) {
    rceditCandidates.push(
      ...(await Array.fromAsync(
        new Bun.Glob("electron-winstaller@*/node_modules/electron-winstaller/vendor/rcedit.exe").scan({
          cwd: bunDir,
          absolute: true,
        }),
      )),
    )
  }
  const hoisted = path.join(rootDir, "node_modules", "electron-winstaller", "vendor", "rcedit.exe")
  if (existsSync(hoisted)) rceditCandidates.push(hoisted)
  const rcedit = rceditCandidates[0]
  const icon = path.resolve(desktopDir, `icons/${channel}/icon.ico`)
  if (rcedit) {
    await $`"${rcedit}" "${dest}" --set-icon "${icon}"`
    console.log(`Copied CLI to ${dest} with icon`)
  } else {
    // electron-winstaller 是 electron-builder 的 optional transitive dep，
    // CI 的 hoisted install 可能不带它；图标缺失不阻塞构建。
    console.warn(`Copied CLI to ${dest} (rcedit.exe not found, icon not set)`)
  }
}
