import type { ServerConnection } from "@/context/server"

export const SESSION_TABS_REMOVED_EVENT = "opencode:session-tabs-removed"
export const SESSION_NOT_FOUND_EVENT = "opencode:session-not-found"

export type SessionTabsRemovedDetail = {
  server?: ServerConnection.Key
  directory: string
  sessionIDs: string[]
}

export type SessionNotFoundDetail = {
  server?: ServerConnection.Key
  sessionID: string
}

export function notifySessionTabsRemoved(input: SessionTabsRemovedDetail) {
  window.dispatchEvent(new CustomEvent(SESSION_TABS_REMOVED_EVENT, { detail: input }))
}

// ErrorBoundary fallbacks stay context-free; they leave a missing session by
// event so TabsProvider can close the tab / leave the route without useTabs.
export function notifySessionNotFound(input: SessionNotFoundDetail) {
  window.dispatchEvent(new CustomEvent(SESSION_NOT_FOUND_EVENT, { detail: input }))
}

export function readSessionTabsRemovedDetail(event: Event): SessionTabsRemovedDetail | undefined {
  if (!(event instanceof CustomEvent)) return undefined

  const detail: unknown = event.detail
  if (!detail || typeof detail !== "object") return undefined
  if (!("directory" in detail)) return undefined
  if (!("sessionIDs" in detail)) return undefined
  if (typeof detail.directory !== "string") return undefined
  if (!Array.isArray(detail.sessionIDs)) return undefined
  if ("server" in detail && detail.server !== undefined && typeof detail.server !== "string") return undefined

  const sessionIDs = detail.sessionIDs.filter((id): id is string => typeof id === "string")
  if (sessionIDs.length === 0) return undefined

  return {
    server:
      "server" in detail && typeof detail.server === "string" ? (detail.server as ServerConnection.Key) : undefined,
    directory: detail.directory,
    sessionIDs,
  }
}

export function readSessionNotFoundDetail(event: Event): SessionNotFoundDetail | undefined {
  if (!(event instanceof CustomEvent)) return undefined

  const detail: unknown = event.detail
  if (!detail || typeof detail !== "object") return undefined
  if (!("sessionID" in detail) || typeof detail.sessionID !== "string") return undefined
  if ("server" in detail && detail.server !== undefined && typeof detail.server !== "string") return undefined

  return {
    server:
      "server" in detail && typeof detail.server === "string" ? (detail.server as ServerConnection.Key) : undefined,
    sessionID: detail.sessionID,
  }
}
