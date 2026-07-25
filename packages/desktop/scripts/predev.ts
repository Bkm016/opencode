import { $ } from "bun"
import { rm, stat } from "node:fs/promises"

const solidPatch = await stat(new URL("../../../patches/solid-js@1.9.10.patch", import.meta.url))
const viteMetadata = await stat(new URL("../node_modules/.vite/deps/_metadata.json", import.meta.url)).catch(() => undefined)

// Patch 更新后必须丢弃 Vite 预构建产物，否则开发端仍会运行旧依赖实现。
if (viteMetadata && solidPatch.mtimeMs > viteMetadata.mtimeMs) {
  await rm(new URL("../node_modules/.vite", import.meta.url), { recursive: true, force: true })
}

await $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL ?? "dev"}`

await $`cd ../opencode && bun script/build-node.ts`
