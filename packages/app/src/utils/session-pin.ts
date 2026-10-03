import type { Session } from "@opencode-ai/sdk/v2/client"
import { createStore, produce } from "solid-js/store"

/**
 * 置顶存在服务端会话的 time.pinned 上（排序键，越大越靠前），换客户端不丢。
 * 这里只保留请求还没落地时的乐观值，落地后以会话数据为准。
 */
const [pending, setPending] = createStore<Record<string, number | null>>({})

type PinnedSession = Pick<Session, "id" | "time">

export function sessionPinKey(session: PinnedSession): number | undefined {
  const value = pending[session.id]
  if (value !== undefined) return value ?? undefined
  return session.time.pinned ?? undefined
}

export function isSessionPinned(session: PinnedSession): boolean {
  return sessionPinKey(session) !== undefined
}

/** Pinned sessions first (most recently pinned first), then the rest in their original order. */
export function withPinnedFirst<T extends PinnedSession>(sessions: T[]): T[] {
  const pinned = sessions.filter(isSessionPinned)
  if (pinned.length === 0) return sessions
  pinned.sort((a, b) => sessionPinKey(b)! - sessionPinKey(a)!)
  return [...pinned, ...sessions.filter((session) => !isSessionPinned(session))]
}

export type SessionPinUpdate = {
  directory: string
  sessionID: string
  time: { pinned: number }
}

// 生成的 SDK 类型里没有 null，但服务端接受 null 作取消置顶
const UNPIN = null as unknown as number

export async function setSessionPinned(input: {
  session: Pick<Session, "id" | "directory" | "time">
  pinned: boolean
  update: (value: SessionPinUpdate) => Promise<{ data?: Session }>
  apply: (info: Session) => void
}) {
  const value = input.pinned ? Date.now() : null
  setPending(input.session.id, value)
  try {
    const result = await input.update({
      directory: input.session.directory,
      sessionID: input.session.id,
      time: { pinned: value ?? UNPIN },
    })
    if (result.data) input.apply(result.data)
  } finally {
    setPending(
      produce((draft) => {
        delete draft[input.session.id]
      }),
    )
  }
}

const LEGACY_STORAGE_KEY = "opencode.session.pinned.v1"

/** 以前置顶存在本地，读出来逐个写到服务端（保持原顺序），写完清掉本地。 */
export async function migrateLegacySessionPins(update: (value: SessionPinUpdate) => Promise<unknown>) {
  let raw: string | null
  try {
    raw = localStorage.getItem(LEGACY_STORAGE_KEY)
  } catch {
    return
  }
  if (!raw) return
  const entries: SessionPinUpdate[] = []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const now = Date.now()
      for (const [directory, ids] of Object.entries(parsed)) {
        if (!Array.isArray(ids)) continue
        ids
          .filter((id): id is string => typeof id === "string")
          .forEach((sessionID, index) => entries.push({ directory, sessionID, time: { pinned: now - index } }))
      }
    }
  } catch {}
  // 会话可能已删或属于别的服务，失败的直接丢掉
  await Promise.allSettled(entries.map((entry) => update(entry)))
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY)
  } catch {}
}
