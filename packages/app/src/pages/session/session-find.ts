import type { Message, Part } from "@opencode-ai/sdk/v2"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { isContextGroupTool } from "@opencode-ai/session-ui/message-part-groups"

export type SessionFindMatch = {
  messageID: string
  userMessageID: string
  partID: string
  start: number
  end: number
}

export function partSearchText(part: Part) {
  if (part.type === "text" || part.type === "reasoning") {
    if (typeof part.text === "string" && part.text.length > 0) return part.text
  }
  if (part.type === "tool") {
    const state = part.state
    const title = "title" in state && typeof state.title === "string" ? state.title : ""
    const output = "output" in state && typeof state.output === "string" ? state.output : ""
    const error = "error" in state && typeof state.error === "string" ? state.error : ""
    if (part.tool === "task" || part.tool === "task_followup") {
      const input = state.input ?? {}
      const metadataValue = "metadata" in state ? state.metadata : undefined
      const metadata =
        metadataValue && typeof metadataValue === "object" && !Array.isArray(metadataValue)
          ? (metadataValue as Record<string, unknown>)
          : {}
      const chunks = [
        typeof input.description === "string" ? input.description : "",
        typeof input.prompt === "string" ? input.prompt : "",
        typeof input.title === "string" ? input.title : "",
        typeof input.agent === "string" ? input.agent : "",
        typeof metadata.description === "string" ? metadata.description : "",
        typeof metadata.title === "string" ? metadata.title : "",
        error,
      ].filter(Boolean)
      return chunks.join("\n")
    }
    if (isContextGroupTool(part)) {
      const input = part.state.input ?? {}
      const filePath = typeof input.filePath === "string" ? input.filePath : undefined
      const path = typeof input.path === "string" ? input.path : undefined
      const pattern = typeof input.pattern === "string" ? input.pattern : ""
      const include = typeof input.include === "string" ? input.include : ""
      const chunks = [
        part.tool === "read" ? getFilename(filePath) : "",
        part.tool === "list_dir" ? getDirectory(path) : "",
        part.tool !== "read" && part.tool !== "list_dir" ? getDirectory(path) : "",
        pattern,
        include,
        part.tool === "read" && typeof input.offset === "number" ? `offset=${input.offset}` : "",
        part.tool === "read" && typeof input.limit === "number" ? `limit=${input.limit}` : "",
      ].filter(Boolean)
      return chunks.join("\n")
    }
    const chunks = [title, output, error].filter(Boolean)
    if (chunks.length > 0) return chunks.join("\n")
  }
  return ""
}

export function messageUserAnchor(message: Message) {
  if (message.role === "user") return message.id
  if (message.role === "assistant" && typeof message.parentID === "string") return message.parentID
  return message.id
}

export function collectSessionFindMatches(input: {
  messages: readonly Message[]
  parts: (messageID: string) => readonly Part[] | undefined
  query: string
  caseSensitive?: boolean
}) {
  const raw = input.query.trim()
  if (!raw) return [] as SessionFindMatch[]

  const caseSensitive = input.caseSensitive === true
  const needle = caseSensitive ? raw : raw.toLowerCase()
  if (!needle) return [] as SessionFindMatch[]

  const matches: SessionFindMatch[] = []
  for (const message of input.messages) {
    const userMessageID = messageUserAnchor(message)
    const list = input.parts(message.id) ?? []
    for (const part of list) {
      const text = partSearchText(part)
      if (!text) continue
      const haystack = caseSensitive ? text : text.toLowerCase()
      let from = 0
      while (from < haystack.length) {
        const at = haystack.indexOf(needle, from)
        if (at < 0) break
        matches.push({
          messageID: message.id,
          userMessageID,
          partID: part.id,
          start: at,
          end: at + needle.length,
        })
        from = at + Math.max(needle.length, 1)
      }
    }
  }
  return matches
}
