import { createStore, produce } from "solid-js/store"
import { pathKey } from "@/utils/path-key"

const STORAGE_KEY = "opencode.session.pinned.v1"

export type SessionPinMap = Record<string, string[]>

function load(): SessionPinMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const result: SessionPinMap = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue
      result[key] = value.filter((id): id is string => typeof id === "string")
    }
    return result
  } catch {
    return {}
  }
}

function save(map: SessionPinMap) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
}

const [store, setStore] = createStore<SessionPinMap>(load())

function snapshot(): SessionPinMap {
  const result: SessionPinMap = {}
  for (const key of Object.keys(store)) {
    const list = store[key]
    if (!list?.length) continue
    result[key] = [...list]
  }
  return result
}

function persist() {
  save(snapshot())
}

/** Pinned session IDs for a workspace directory (most recently pinned first). */
export function pinnedSessionIds(directory: string): string[] {
  return store[pathKey(directory)] ?? []
}

export function isSessionPinned(directory: string, sessionID: string): boolean {
  return pinnedSessionIds(directory).includes(sessionID)
}

/** Prepend session to pin list; re-pin moves it to front. */
export function pinSession(directory: string, sessionID: string) {
  const key = pathKey(directory)
  const list = store[key] ?? []
  setStore(key, [sessionID, ...list.filter((id) => id !== sessionID)])
  persist()
}

export function unpinSession(directory: string, sessionID: string) {
  const key = pathKey(directory)
  const list = store[key] ?? []
  if (!list.includes(sessionID)) return
  const next = list.filter((id) => id !== sessionID)
  if (next.length === 0) {
    setStore(produce((draft) => {
      delete draft[key]
    }))
    persist()
    return
  }
  setStore(key, next)
  persist()
}

export function toggleSessionPin(directory: string, sessionID: string) {
  if (isSessionPinned(directory, sessionID)) {
    unpinSession(directory, sessionID)
    return
  }
  pinSession(directory, sessionID)
}

/** Drop a pin id (e.g. after archive). No-op when not pinned. */
export function removeSessionPin(directory: string, sessionID: string) {
  unpinSession(directory, sessionID)
}

/** Pure helpers for tests — operate on a plain map without touching storage. */
export function pinListOf(map: SessionPinMap, directory: string): string[] {
  return map[pathKey(directory)] ?? []
}

export function withPinnedSession(map: SessionPinMap, directory: string, sessionID: string): SessionPinMap {
  const key = pathKey(directory)
  const list = map[key] ?? []
  return { ...map, [key]: [sessionID, ...list.filter((id) => id !== sessionID)] }
}

export function withoutPinnedSession(map: SessionPinMap, directory: string, sessionID: string): SessionPinMap {
  const key = pathKey(directory)
  const list = map[key] ?? []
  if (!list.includes(sessionID)) return map
  const next = list.filter((id) => id !== sessionID)
  if (next.length === 0) {
    const result = { ...map }
    delete result[key]
    return result
  }
  return { ...map, [key]: next }
}
