import { base64Encode } from "@opencode-ai/core/util/encode"
import { decode64 } from "@/utils/base64"
import { pathKey } from "@/utils/path-key"

export function acceptKey(sessionID: string, directory?: string) {
  if (!directory) return sessionID
  // Event directories may use forward slashes while the composer uses native Windows separators.
  // Normalize before persistence so descendants resolve the same override as their parent session.
  return `${base64Encode(pathKey(directory))}/${sessionID}`
}

export function directoryAcceptKey(directory: string) {
  return `${base64Encode(pathKey(directory))}/*`
}

function legacyScopedValue(autoAccept: Record<string, boolean>, directory: string, suffix: string) {
  // Older persisted keys encoded the raw path. Decode them during lookup so an existing bypass
  // survives upgrades and still matches child events that use another separator style.
  return Object.entries(autoAccept).find(([key]) => {
    if (!key.endsWith(suffix)) return false
    const storedDirectory = decode64(key.slice(0, -suffix.length))
    return storedDirectory !== undefined && pathKey(storedDirectory) === pathKey(directory)
  })?.[1]
}

function accepted(autoAccept: Record<string, boolean>, sessionID: string, directory?: string) {
  const key = acceptKey(sessionID, directory)
  return (
    autoAccept[key] ??
    autoAccept[sessionID] ??
    (directory ? autoAccept[`${base64Encode(directory)}/${sessionID}`] : undefined) ??
    (directory ? legacyScopedValue(autoAccept, directory, `/${sessionID}`) : undefined)
  )
}

export function isDirectoryAutoAccepting(autoAccept: Record<string, boolean>, directory: string) {
  const key = directoryAcceptKey(directory)
  return (
    autoAccept[key] ??
    autoAccept[`${base64Encode(directory)}/*`] ??
    legacyScopedValue(autoAccept, directory, "/*") ??
    false
  )
}

function sessionLineage(session: { id: string; parentID?: string }[], sessionID: string) {
  const parent = session.reduce((acc, item) => {
    if (item.parentID) acc.set(item.id, item.parentID)
    return acc
  }, new Map<string, string>())
  const seen = new Set([sessionID])
  const ids = [sessionID]

  for (const id of ids) {
    const parentID = parent.get(id)
    if (!parentID || seen.has(parentID)) continue
    seen.add(parentID)
    ids.push(parentID)
  }

  return ids
}

export function autoRespondsPermission(
  autoAccept: Record<string, boolean>,
  session: { id: string; parentID?: string }[],
  permission: { sessionID: string },
  directory?: string,
) {
  const value = sessionAutoAccept(autoAccept, session, permission, directory)
  if (value !== undefined) return value
  return directory ? isDirectoryAutoAccepting(autoAccept, directory) : false
}

export function sessionAutoAccept(
  autoAccept: Record<string, boolean>,
  session: { id: string; parentID?: string }[],
  permission: { sessionID: string },
  directory?: string,
) {
  return sessionLineage(session, permission.sessionID)
    .map((id) => accepted(autoAccept, id, directory))
    .find((item): item is boolean => item !== undefined)
}
