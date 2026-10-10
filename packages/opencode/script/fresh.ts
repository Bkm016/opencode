import fs from "fs"
import path from "path"

const dir = path.resolve(import.meta.dirname, "..")

// opencode 及其打进产物的 workspace 包源码；任一文件比产物新就需要重建。
const roots = [
  path.join(dir, "src"),
  path.join(dir, "script"),
  path.join(dir, "package.json"),
  // app/ui 是内置 Web UI 的源码
  ...["core", "protocol", "schema", "server", "llm", "codemode", "plugin", "sdk/js", "app", "ui"].map((name) =>
    path.resolve(dir, "..", name, "src"),
  ),
]

export function isFresh(outFile: string) {
  if (!fs.existsSync(outFile)) return false
  const outMtime = fs.statSync(outFile).mtimeMs
  return roots.every((root) => newestMtime(root) <= outMtime)
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
