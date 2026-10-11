import { Binary } from "@opencode-ai/core/util/binary"
import type { AssistantMessage, Message, Part, SessionStatus, UserMessage } from "@opencode-ai/sdk/v2"
import { createMemo, mapArray, type Accessor } from "solid-js"
import { reuseTimelineRows } from "./row-reconciliation"
import { Timeline, TimelineRow } from "./rows"

export { reuseTimelineRows } from "./row-reconciliation"

const emptyAssistantMessages: AssistantMessage[] = []

export function createTimelineProjection(input: {
  messages: Accessor<Message[]>
  userMessages: Accessor<UserMessage[]>
  parts: (messageID: string) => Part[]
  status: Accessor<SessionStatus>
  showReasoningSummaries: Accessor<boolean>
}) {
  const messageByID = createMemo(() => new Map(input.messages().map((message) => [message.id, message] as const)))
  const assistantMessagesByParent = createMemo(() => {
    const result = new Map<string, AssistantMessage[]>()
    input.messages().forEach((message) => {
      if (message.role !== "assistant") return
      const messages = result.get(message.parentID)
      if (messages) {
        messages.push(message)
        return
      }
      result.set(message.parentID, [message])
    })
    return result
  })
  // 进行中 turn 被折叠时，压缩消息落在该 turn 的步骤之间：并入所属 turn 内联显示，不另起一轮排到末尾。
  const inlineFolds = createMemo(() => {
    const owners = new Map<string, string>()
    const byOwner = new Map<string, string[]>()
    const users = new Set(input.userMessages().map((message) => message.id))
    for (const message of input.userMessages()) {
      const part = input.parts(message.id).find((item) => item.type === "compaction")
      if (part?.type !== "compaction") continue
      const chunk = part.chunks?.at(-1)
      if (chunk?.status !== "partial") continue
      const owner = owners.get(chunk.start_message_id) ?? chunk.start_message_id
      if (owner >= message.id || !users.has(owner)) continue
      owners.set(message.id, owner)
      const folds = byOwner.get(owner)
      if (folds) folds.push(message.id)
      else byOwner.set(owner, [message.id])
    }
    return { owners, byOwner }
  })
  const turnMessages = createMemo(
    () => {
      const { owners } = inlineFolds()
      if (owners.size === 0) return input.userMessages()
      return input.userMessages().filter((message) => !owners.has(message.id))
    },
    undefined,
    { equals: (a, b) => a.length === b.length && a.every((item, index) => item === b[index]) },
  )
  const activeTurnID = createMemo(() => {
    const parentID = input
      .messages()
      .findLast(
        (message): message is AssistantMessage =>
          message.role === "assistant" && typeof message.time.completed !== "number",
      )?.parentID
    if (parentID) {
      const messages = input.messages()
      const result = Binary.search(messages, parentID, (message) => message.id)
      const message = result.found ? messages[result.index] : messages.find((item) => item.id === parentID)
      if (message?.role === "user") return message.id
    }

    if (input.status().type === "idle") return
    return input.messages().findLast((message) => message.role === "user")?.id
  })
  const activeMessageID = createMemo(() => {
    const id = activeTurnID()
    return id ? (inlineFolds().owners.get(id) ?? id) : id
  })
  const messageRowMemos = createMemo(
    mapArray(turnMessages, (userMessage, indexAccessor) =>
      createMemo((previous: TimelineRow.TimelineRow[] | undefined) =>
        reuseTimelineRows(
          previous,
          Timeline.constructMessageRows(
            userMessage,
            input.parts,
            assistantMessagesByParent().get(userMessage.id) ?? emptyAssistantMessages,
            indexAccessor(),
            input.showReasoningSummaries(),
            input.status().type,
            activeMessageID() === userMessage.id,
            inlineFolds().byOwner.get(userMessage.id),
          ),
        ),
      ),
    ),
  )
  const rows = createMemo((previous: TimelineRow.TimelineRow[] | undefined) =>
    reuseTimelineRows(
      previous,
      messageRowMemos().flatMap((memo) => memo()),
    ),
  )
  const rowByKey = createMemo(() => new Map(rows().map((row) => [TimelineRow.key(row), row] as const)))
  const messageRowIndex = createMemo(() => {
    const result = new Map<string, number>()
    rows().forEach((row, index) => {
      if (!("userMessageID" in row) || result.has(row.userMessageID)) return
      result.set(row.userMessageID, index)
    })
    return result
  })
  const messageLastRowIndex = createMemo(() => {
    const result = new Map<string, number>()
    rows().forEach((row, index) => {
      if ("userMessageID" in row) result.set(row.userMessageID, index)
    })
    return result
  })
  const lastAssistantGroupKey = createMemo(() => {
    const result = new Map<string, string>()
    rows().forEach((row) => {
      if (row._tag === "AssistantPart") result.set(row.userMessageID, row.group.key)
    })
    return result
  })

  return {
    activeMessageID,
    assistantMessagesByParent,
    lastAssistantGroupKey,
    messageByID,
    messageRowIndex,
    messageLastRowIndex,
    rowByKey,
    rows,
  }
}
