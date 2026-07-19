export type PathKey = string & { _brand: "PathKey" }

const isDrive = (value: string) => {
  if (value.length !== 2) return false
  const code = value.charCodeAt(0)
  return value[1] === ":" && ((code >= 65 && code <= 90) || (code >= 97 && code <= 122))
}

const trimTrailingSlashes = (value: string) => {
  for (let i = value.length - 1; i >= 0; i--) {
    if (value[i] !== "/") return value.slice(0, i + 1)
  }
  return ""
}

const isWindowsPath = (value: string) => value[1] === ":" || value.startsWith("\\\\")

export const pathKey = (path: string) => {
  const value = isWindowsPath(path) ? path.replaceAll("\\", "/") : path
  const trimmed = trimTrailingSlashes(value)
  if (!trimmed && value.startsWith("/")) return "/" as PathKey
  if (isDrive(trimmed)) return `${trimmed}/` as PathKey
  return trimmed as PathKey
}

export const isPathInside = (root: string, target: string) => {
  const windows = isWindowsPath(root) || isWindowsPath(target)
  const parent = windows ? pathKey(root).toLowerCase() : pathKey(root)
  const child = windows ? pathKey(target).toLowerCase() : pathKey(target)
  if (!parent) return false
  const prefix = parent.endsWith("/") ? parent : `${parent}/`
  return child === parent || child.startsWith(prefix)
}
