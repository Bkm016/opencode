import type { Session } from "@opencode-ai/sdk/v2/client"
import { createSignal } from "solid-js"

/**
 * 助手：挂在主会话下、共享主会话上下文的子会话（metadata.assistant = true），每个主会话一个。
 * 输入框切到助手模式后，发送的内容进入助手会话，主会话不受打扰。
 */

const [modes, setModes] = createSignal<Record<string, boolean>>({})

export function assistantMode(sessionID: string | undefined) {
  return !!sessionID && !!modes()[sessionID]
}

export function setAssistantMode(sessionID: string, value: boolean) {
  setModes((prev) => ({ ...prev, [sessionID]: value }))
}

export function isAssistantSession(session: Pick<Session, "parentID" | "metadata"> | undefined) {
  return !!session?.parentID && session.metadata?.assistant === true
}

export function findAssistant(sessions: Session[], mainID: string) {
  return sessions.find((session) => session.parentID === mainID && isAssistantSession(session) && !session.time.archived)
}

const creating = new Map<string, Promise<Session | undefined>>()

/** 找到主会话的助手会话，没有就创建；并发调用共用同一次创建。 */
export function ensureAssistant(input: {
  mainID: string
  sessions: Session[]
  client: {
    session: {
      children: (args: { sessionID: string }) => Promise<{ data?: Session[] }>
      create: (args: {
        parentID: string
        title: string
        metadata: Record<string, unknown>
      }) => Promise<{ data?: Session }>
    }
  }
  remember: (session: Session) => void
  title: string
}) {
  const known = findAssistant(input.sessions, input.mainID)
  if (known) return Promise.resolve(known)
  const running = creating.get(input.mainID)
  if (running) return running
  const task = (async () => {
    const children = await input.client.session.children({ sessionID: input.mainID }).then((x) => x.data ?? [])
    const existing = findAssistant(children, input.mainID)
    if (existing) {
      input.remember(existing)
      return existing
    }
    const created = await input.client.session
      .create({ parentID: input.mainID, title: input.title, metadata: { assistant: true } })
      .then((x) => x.data ?? undefined)
    if (created) input.remember(created)
    return created
  })().finally(() => creating.delete(input.mainID))
  creating.set(input.mainID, task)
  return task
}
