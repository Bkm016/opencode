// One-shot Linux backend build, mirrors .github/workflows/backend-linux.yml
// Usage: bun ./script/build-linux-backend.ts
import { $ } from "bun"
import path from "node:path"
import { fileURLToPath } from "node:url"

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const opencodeDir = path.join(rootDir, "packages", "opencode")
const artifact = "opencode-linux-x64-baseline.tar.gz"
const binaryDir = path.join(opencodeDir, "dist", "opencode-linux-x64-baseline", "bin")

process.env.NODE_OPTIONS ??= "--max-old-space-size=4096"

console.log("Building Linux backend")

$.cwd(opencodeDir)
if (process.platform === "linux" && process.arch === "x64") {
  await $`bun ./script/build.ts --single --baseline --skip-embed-web-ui`
} else {
  await $`bun ./script/build.ts --os=linux --arch=x64 --baseline --skip-embed-web-ui`
}
await $`tar -czf ../../${artifact} opencode`.cwd(binaryDir)

console.log(`Done. Artifact: ${path.join(opencodeDir, "dist", artifact)}`)
