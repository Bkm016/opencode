import path from "path"

export function abbreviateHome(input: string, home: string) {
  if (!home) return input
  const relative = path.relative(home, input)
  if (relative === "") return "~"
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return input
  return "~" + path.sep + relative
}

/** Resolves a user-entered directory while accepting either slash style after `~` for remote and cross-platform paths. */
export function resolveUserPath(input: string, home: string, cwd: string) {
  const value = input.trim()
  if (value === "~") return home
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.resolve(home, ...value.slice(2).split(/[\\/]+/))
  }
  return path.resolve(cwd, value)
}
