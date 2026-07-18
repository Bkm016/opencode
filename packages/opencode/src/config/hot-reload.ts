export * as ConfigHotReload from "./hot-reload"

import path from "path"

const IGNORE_SEGMENTS = /(?:^|[\\/])(?:node_modules|\.git)(?:[\\/]|$)/i
const IGNORE_BASENAMES = new Set([
  ".gitignore",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
])

const CONFIG_BASENAMES = new Set(["opencode.json", "opencode.jsonc", "config.json"])
const PLUGIN_EXT = /\.(?:ts|js|mjs|cjs)$/i
const MD_EXT = /\.md$/i

function normalize(file: string) {
  return file.replace(/\\/g, "/")
}

function hasSegment(file: string, names: string[]) {
  const parts = normalize(file).split("/")
  return parts.some((part) => names.includes(part))
}

/** True when a filesystem change should trigger instance config/skill/plugin reload. */
export function isConfigHotReloadPath(file: string) {
  if (!file) return false
  if (IGNORE_SEGMENTS.test(file)) return false

  const base = path.basename(file)
  if (IGNORE_BASENAMES.has(base)) return false
  if (CONFIG_BASENAMES.has(base)) return true
  if (base === "SKILL.md") return true
  if (hasSegment(file, ["skill", "skills"]) && MD_EXT.test(base)) return true
  if (hasSegment(file, ["plugin", "plugins"]) && PLUGIN_EXT.test(base)) return true
  if (hasSegment(file, ["agent", "agents", "command", "commands"]) && MD_EXT.test(base)) return true
  return false
}

export const DEBOUNCE_MS = 300
