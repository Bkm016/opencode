import { createStore } from "solid-js/store"

const STORAGE_KEY = "opencode.session.groups.v1"
const MAX_ENTRIES = 200

export type SessionGroupMap = Record<string, boolean>

function storageKey(scope: string, key: string) {
  return `${scope}:${key}`
}

function load(): SessionGroupMap {
  try {
    if (typeof localStorage !== "object") return {}
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const result: SessionGroupMap = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "boolean") continue
      result[key] = value
    }
    const keys = Object.keys(result)
    if (keys.length <= MAX_ENTRIES) return result
    const pruned: SessionGroupMap = {}
    for (const key of keys.slice(-MAX_ENTRIES)) {
      const value = result[key]
      if (typeof value === "boolean") pruned[key] = value
    }
    return pruned
  } catch {
    return {}
  }
}

function save(map: SessionGroupMap) {
  try {
    if (typeof localStorage !== "object") return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    return
  }
}

const [store, setStore] = createStore<SessionGroupMap>(load())

function snapshot(): SessionGroupMap {
  const result: SessionGroupMap = {}
  for (const key of Object.keys(store)) {
    const value = store[key]
    if (typeof value !== "boolean") continue
    result[key] = value
  }
  const keys = Object.keys(result)
  if (keys.length <= MAX_ENTRIES) return result
  const pruned: SessionGroupMap = {}
  for (const key of keys.slice(-MAX_ENTRIES)) {
    const value = result[key]
    if (typeof value === "boolean") pruned[key] = value
  }
  return pruned
}

function persist() {
  save(snapshot())
}

/** 指定侧栏列表内分组的记忆状态，未记忆时返回 undefined，由调用方回落到默认折叠。 */
export function sessionGroupOpen(scope: string, key: string): boolean | undefined {
  return store[storageKey(scope, key)]
}

/** 记住指定侧栏列表内分组的展开 / 折叠，跨刷新生效。 */
export function setSessionGroupOpen(scope: string, key: string, open: boolean) {
  setStore(storageKey(scope, key), open)
  persist()
}

/** Pure helpers for tests — operate on a plain map without touching storage. */
export function groupOpenOf(map: SessionGroupMap, scope: string, key: string): boolean | undefined {
  return map[storageKey(scope, key)]
}

export function withSessionGroup(
  map: SessionGroupMap,
  scope: string,
  key: string,
  open: boolean,
): SessionGroupMap {
  return { ...map, [storageKey(scope, key)]: open }
}
