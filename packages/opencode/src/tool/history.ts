import { Effect, Schema } from "effect"
import { Session } from "@/session/session"
import { SessionChunk } from "@/session/chunk"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import * as Tool from "./tool"

/**
 * 历史检索工具。chunk 历史通过 display ID 定位，超长 user text 通过 message/part
 * 引用定位。两个工具都强制使用 Tool.Context.sessionID，避免跨 session 读取。
 */

const GrepParameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "Fixed string to search for (not a regex)" }),
  case_sensitive: Schema.optional(Schema.Boolean).annotate({ description: "Default false" }),
  chunk_id: Schema.optional(Schema.String).annotate({
    description: "8-character chunk display ID to scope the search",
  }),
  message_id: Schema.optional(Schema.String).annotate({ description: "User message ID for searching an unbounded text part" }),
  part_id: Schema.optional(Schema.String).annotate({ description: "Text part ID, used with message_id" }),
  head_limit: Schema.optional(Schema.Number).annotate({ description: "Hits to return (default 20, maximum 20)" }),
})

const ListParameters = Schema.Struct({
  chunk_id: Schema.optional(Schema.String).annotate({ description: "8-character chunk display ID" }),
  message_id: Schema.optional(Schema.String).annotate({ description: "User message ID for reading an unbounded text part" }),
  part_id: Schema.optional(Schema.String).annotate({ description: "Text part ID, used with message_id" }),
  offset: Schema.optional(Schema.Number).annotate({ description: "Transcript line offset (default 0)" }),
  limit: Schema.optional(Schema.Number).annotate({ description: "Lines to return (default 80, maximum 80)" }),
})

interface GrepMeta {
  matches: number
  transcript_version?: number
}

interface ListMeta {
  lines: number
  total?: number
  offset?: number
  transcript_version?: number
}

type HistoryCtx = {
  messages: SessionV1.WithParts[]
  chunks: SessionChunk.Chunk[]
}

/** 读取当前 session 的原始消息与最新 chunk 元数据，允许无 checkpoint 的首轮历史。 */
function loadHistoryCtx(sessions: Session.Interface, sessionID: Tool.Context["sessionID"]) {
  return sessions.messages({ sessionID }).pipe(
    Effect.orDie,
    Effect.map((messages) => {
      const compactionMsg = messages.findLast((msg) =>
        msg.parts.some((part): part is SessionV1.CompactionPart => part.type === "compaction" && part.chunks !== undefined),
      )
      const part = compactionMsg?.parts.find(
        (item): item is SessionV1.CompactionPart => item.type === "compaction" && item.chunks !== undefined,
      )
      const chunks = part?.chunks ?? []
      return { messages, chunks } satisfies HistoryCtx
    }),
  )
}

/** 当前 session 内 displayID -> chunk 重新验证 */
function resolveChunk(ctx: HistoryCtx, displayID: string) {
  return ctx.chunks.find((chunk) => chunk.display_id === displayID)
}

export const HistoryGrepTool = Tool.define(
  "history_grep",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return {
      description:
        "Search folded conversation history or a referenced original user text by fixed string. Use message_id and part_id from a user-text-reference to search text that is too large for the model context.",
      parameters: GrepParameters,
      execute: (params: Schema.Schema.Type<typeof GrepParameters>, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult<GrepMeta>> =>
        loadHistoryCtx(sessions, ctx.sessionID).pipe(
          Effect.flatMap((chunkCtx) => {
            if (params.message_id && params.chunk_id) {
              return Effect.succeed({
                title: params.pattern,
                metadata: { matches: 0 },
                output: "Use either chunk_id or message_id, not both.",
              })
            }
            if (params.part_id && !params.message_id) {
              return Effect.succeed({
                title: params.pattern,
                metadata: { matches: 0 },
                output: "part_id requires message_id.",
              })
            }
            if (params.message_id) {
              const entries = SessionChunk.userTextTranscript({
                messages: chunkCtx.messages,
                messageID: params.message_id,
                partID: params.part_id,
              })
              if (entries.length === 0) {
                return Effect.succeed({
                  title: params.pattern,
                  metadata: { matches: 0 },
                  output: `Unknown user text reference message=${params.message_id}${params.part_id ? ` part=${params.part_id}` : ""}.`,
                })
              }
              const needle = params.case_sensitive ? params.pattern : params.pattern.toLowerCase()
              const hits = entries.flatMap((entry, index) => {
                const haystack = params.case_sensitive ? entry.text : entry.text.toLowerCase()
                if (!haystack.includes(needle)) return []
                return [{
                  ...entry,
                  context: [...entries.slice(Math.max(0, index - 2), index), ...entries.slice(index + 1, index + 3)],
                }]
              }).slice(0, Math.min(Math.max(Math.trunc(params.head_limit ?? 20), 1), 20))
              if (hits.length === 0) {
                return Effect.succeed({ title: params.pattern, metadata: { matches: 0 }, output: "No matches in referenced user text." })
              }
              const output = hits
                .map((hit) => {
                  const context = SessionChunk.formatUserTextTranscript(hit.context, "  ")
                  return [
                    `message ${hit.messageID} part ${hit.partID} USER line ${hit.line}:`,
                    `  ${hit.text}`,
                    ...(context ? ["  context:", context] : []),
                  ].join("\n")
                })
                .join("\n\n")
              return Effect.succeed({
                title: params.pattern,
                metadata: { matches: hits.length, transcript_version: SessionChunk.TRANSCRIPT_VERSION },
                output,
              })
            }
            if (chunkCtx.chunks.length === 0) {
              return Effect.succeed({
                title: params.pattern,
                metadata: { matches: 0 },
                output: "No folded history available (no chunk checkpoints in this session).",
              })
            }
            if (params.chunk_id && !resolveChunk(chunkCtx, params.chunk_id)) {
              return Effect.succeed({
                title: params.pattern,
                metadata: { matches: 0 },
                output: `Unknown chunk ID "${params.chunk_id}" in this session.`,
              })
            }
            const hits = SessionChunk.grep({
              messages: chunkCtx.messages,
              chunks: chunkCtx.chunks,
              pattern: params.pattern,
              caseSensitive: params.case_sensitive,
              chunkID: params.chunk_id,
              headLimit: Math.min(Math.max(Math.trunc(params.head_limit ?? 20), 1), 20),
            })
            if (hits.length === 0) {
              return Effect.succeed({ title: params.pattern, metadata: { matches: 0 }, output: "No matches in folded history." })
            }
            const output = hits
              .map((hit) => {
                const context = SessionChunk.formatTranscript(hit.context, "  ")
                return [
                  `chunk ${hit.chunk.display_id} (sequence ${hit.chunk.sequence}) ${hit.source} line ${hit.line}:`,
                  `  ${hit.text}`,
                  ...(context ? ["  context:", context] : []),
                ].join("\n")
              })
              .join("\n\n")
            return Effect.succeed({
              title: params.pattern,
              metadata: { matches: hits.length, transcript_version: SessionChunk.TRANSCRIPT_VERSION },
              output,
            })
          }),
        ),
    }
  }),
)

export const HistoryListTool = Tool.define(
  "history_list",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return {
      description:
        "List a folded chunk or a referenced original user text by line range. Use history_grep first to locate a line. Output is plain transcript lines, subject to normal tool truncation.",
      parameters: ListParameters,
      execute: (params: Schema.Schema.Type<typeof ListParameters>, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult<ListMeta>> =>
        loadHistoryCtx(sessions, ctx.sessionID).pipe(
          Effect.flatMap((chunkCtx) => {
            if (params.chunk_id && params.message_id) {
              return Effect.succeed({
                title: params.chunk_id,
                metadata: { lines: 0 },
                output: "Use either chunk_id or message_id, not both.",
              })
            }
            if (params.part_id && !params.message_id) {
              return Effect.succeed({
                title: params.message_id ?? params.chunk_id ?? "history",
                metadata: { lines: 0 },
                output: "part_id requires message_id.",
              })
            }
            const offset = Math.max(Math.trunc(params.offset ?? 0), 0)
            const limit = Math.min(Math.max(Math.trunc(params.limit ?? 80), 1), 80)
            if (params.message_id) {
              const entries = SessionChunk.userTextTranscript({
                messages: chunkCtx.messages,
                messageID: params.message_id,
                partID: params.part_id,
              })
              const slice = entries.slice(offset, offset + limit)
              if (entries.length === 0) {
                return Effect.succeed({
                  title: params.message_id,
                  metadata: { lines: 0 },
                  output: `Unknown user text reference message=${params.message_id}${params.part_id ? ` part=${params.part_id}` : ""}.`,
                })
              }
              if (slice.length === 0) {
                return Effect.succeed({
                  title: params.message_id,
                  metadata: { lines: 0, total: entries.length, offset, transcript_version: SessionChunk.TRANSCRIPT_VERSION },
                  output: `No user text lines at offset ${offset} (total ${entries.length}).`,
                })
              }
              return Effect.succeed({
                title: `message ${params.message_id}`,
                metadata: {
                  lines: slice.length,
                  total: entries.length,
                  offset,
                  transcript_version: SessionChunk.TRANSCRIPT_VERSION,
                },
                output: SessionChunk.formatUserTextTranscript(slice),
              })
            }
            if (!params.chunk_id) {
              return Effect.succeed({
                title: "history",
                metadata: { lines: 0 },
                output: "Provide either chunk_id or message_id.",
              })
            }
            const chunk = resolveChunk(chunkCtx, params.chunk_id)
            if (!chunk) {
              return Effect.succeed({
                title: params.chunk_id,
                metadata: { lines: 0 },
                output: `Unknown chunk ID "${params.chunk_id}" in this session.`,
              })
            }
            const entries = SessionChunk.transcript({
              messages: chunkCtx.messages,
              chunks: [chunk],
            })
            const slice = entries.slice(offset, offset + limit)
            if (slice.length === 0) {
              return Effect.succeed({
                title: params.chunk_id,
                metadata: { lines: 0, total: entries.length, transcript_version: SessionChunk.TRANSCRIPT_VERSION },
                output: `No transcript lines at offset ${offset} (total ${entries.length}).`,
              })
            }
            return Effect.succeed({
              title: `chunk ${chunk.display_id}`,
              metadata: {
                lines: slice.length,
                total: entries.length,
                offset,
                transcript_version: SessionChunk.TRANSCRIPT_VERSION,
              },
              output: SessionChunk.formatTranscript(slice),
            })
          }),
        ),
    }
  }),
)
