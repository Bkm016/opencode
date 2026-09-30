/**
 * 跨会话改动保护：助手与主会话在同一工作区并行工作，一方改过的文件，另一方必须先重新读取才能再改，
 * 避免拿着过期内容把对方的改动覆盖掉。只跟踪编辑类工具的写入，不干预同一会话自己的读写节奏。
 */

let clock = 0
// 文件 → 最近一次通过编辑类工具写入它的会话与时刻
const written = new Map<string, { sessionID: string; at: number }>()
// 会话+文件 → 该会话最近一次读取或写入它的时刻
const seen = new Map<string, number>()

const key = (sessionID: string, file: string) => `${sessionID}\0${file}`

/** read 工具读取成功，或编辑类工具写入成功后调用。 */
export function saw(sessionID: string, file: string) {
  seen.set(key(sessionID, file), ++clock)
}

export function wrote(sessionID: string, file: string) {
  const at = ++clock
  written.set(file, { sessionID, at })
  seen.set(key(sessionID, file), at)
}

/** 另一个会话在本会话最近一次读取之后改过这个文件时拒绝写入。 */
export function assertFresh(sessionID: string, file: string) {
  const last = written.get(file)
  if (!last || last.sessionID === sessionID) return
  if ((seen.get(key(sessionID, file)) ?? 0) > last.at) return
  throw new Error(
    `File ${file} was modified by another session (possibly the assistant) since you last read it. Read it again before editing.`,
  )
}

export * as FileGuard from "./file-guard"
