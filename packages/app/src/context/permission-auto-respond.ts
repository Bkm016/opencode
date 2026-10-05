import { base64Encode } from "@opencode-ai/core/util/encode"
import { decode64 } from "@/utils/base64"
import { pathKey } from "@/utils/path-key"

// true 自动接受除控制电脑外的权限；"computer" 连 computer_use 也自动接受
export type AcceptValue = boolean | "computer"
export type AcceptLevel = "off" | "on" | "computer"
type AcceptStore = Record<string, AcceptValue>

const COMPUTER_USE = "computer_use"

export function acceptLevel(value: AcceptValue | undefined): AcceptLevel {
  if (value === "computer") return "computer"
  return value ? "on" : "off"
}

export function acceptValue(level: AcceptLevel): AcceptValue {
  if (level === "computer") return "computer"
  return level === "on"
}

export function covers(value: AcceptValue | undefined, permission?: string) {
  if (value === "computer") return true
  return value === true && permission !== COMPUTER_USE
}

// 控制电脑只在 Windows 服务器上可用，其他平台不出这一档
export function canControlComputer(directory: string) {
  return /^[A-Za-z]:[\\/]/.test(directory) || directory.startsWith("\\\\")
}

export function nextAcceptLevel(level: AcceptLevel, directory: string): AcceptLevel {
  if (level === "off") return "on"
  if (level === "on" && canControlComputer(directory)) return "computer"
  return "off"
}

export function acceptKey(sessionID: string, directory?: string) {
  if (!directory) return sessionID
  // Event directories may use forward slashes while the composer uses native Windows separators.
  // Normalize before persistence so descendants resolve the same override as their parent session.
  return `${base64Encode(pathKey(directory))}/${sessionID}`
}

export function directoryAcceptKey(directory: string) {
  return `${base64Encode(pathKey(directory))}/*`
}

function legacyScopedValue(autoAccept: AcceptStore, directory: string, suffix: string) {
  // Older persisted keys encoded the raw path. Decode them during lookup so an existing bypass
  // survives upgrades and still matches child events that use another separator style.
  return Object.entries(autoAccept).find(([key]) => {
    if (!key.endsWith(suffix)) return false
    const storedDirectory = decode64(key.slice(0, -suffix.length))
    return storedDirectory !== undefined && pathKey(storedDirectory) === pathKey(directory)
  })?.[1]
}

function accepted(autoAccept: AcceptStore, sessionID: string, directory?: string) {
  const key = acceptKey(sessionID, directory)
  return (
    autoAccept[key] ??
    autoAccept[sessionID] ??
    (directory ? autoAccept[`${base64Encode(directory)}/${sessionID}`] : undefined) ??
    (directory ? legacyScopedValue(autoAccept, directory, `/${sessionID}`) : undefined)
  )
}

export function isDirectoryAutoAccepting(autoAccept: AcceptStore, directory: string) {
  return directoryAutoAccept(autoAccept, directory) !== false
}

export function directoryAutoAccept(autoAccept: AcceptStore, directory: string): AcceptValue {
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

export function autoAcceptValue(
  autoAccept: AcceptStore,
  session: { id: string; parentID?: string }[],
  permission: { sessionID: string },
  directory?: string,
): AcceptValue {
  const value = sessionAutoAccept(autoAccept, session, permission, directory)
  if (value !== undefined) return value
  return directory ? directoryAutoAccept(autoAccept, directory) : false
}

// 不带 permission 时只问"是否开着自动接受"，哪一档都算
export function autoRespondsPermission(
  autoAccept: AcceptStore,
  session: { id: string; parentID?: string }[],
  permission: { sessionID: string; permission?: string },
  directory?: string,
) {
  const value = autoAcceptValue(autoAccept, session, permission, directory)
  if (permission.permission === undefined) return value !== false
  return covers(value, permission.permission)
}

export function sessionAutoAccept(
  autoAccept: AcceptStore,
  session: { id: string; parentID?: string }[],
  permission: { sessionID: string },
  directory?: string,
) {
  return sessionLineage(session, permission.sessionID)
    .map((id) => accepted(autoAccept, id, directory))
    .find((item): item is AcceptValue => item !== undefined)
}
