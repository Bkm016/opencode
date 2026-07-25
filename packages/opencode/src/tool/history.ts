import { Effect, Schema } from "effect"
import { Session } from "@/session/session"
import { SessionChunk } from "@/session/chunk"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import * as Tool from "./tool"

/**
 * 折叠历史检索工具。仅当当前 session 存在 chunk checkpoint 时由 registry
 * 条件暴露。两个工具复用同一个规范化 transcript 实现（SessionChunk.transcript），
 * 行号与格式版本一致。不接受 sessionID 参数，强制使用 Tool.Context.sessionID，
 * (sessionID, displayID) 每次重新验证，子 session 只命中子 session 数据。
 */

const GrepParameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "Fixed string to search for (not a regex)" }),
  case_sensitive: Schema.optional(Schema.Boolean).annotate({ description: "Default false" }),
  chunk_id: Schema.optional(Schema.String).annotate({
    description: "8-character chunk display ID to scope the search",
  }),
  head_limit: Schema.optional(Schema.Number).annotate({ description: "Max hits to return (default 20)" }),
})

const ListParameters = Schema.Struct({
  chunk_id: Schema.String.annotate({ description: "8-character chunk display ID" }),
  offset: Schema.optional(Schema.Number).annotate({ description: "Transcript line offset (default 0)" }),
  limit: Schema.optional(Schema.Number).annotate({ description: "Max lines to return (default 80)" }),
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

type ChunkCtx = {
  messages: SessionV1.WithParts[]
  chunks: SessionChunk.Chunk[]
}

/** 读取当前 session 的原始消息与最新 chunk 元数据；无 checkpoint 时返回 undefined */
function loadChunkCtx(sessions: Session.Interface, sessionID: Tool.Context["sessionID"]) {
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
      if (chunks.length === 0) return undefined
      return { messages, chunks } satisfies ChunkCtx
    }),
  )
}

/** 当前 session 内 displayID -> chunk 重新验证 */
function resolveChunk(ctx: ChunkCtx, displayID: string) {
  return ctx.chunks.find((chunk) => chunk.display_id === displayID)
}

function formatEntry(entry: SessionChunk.TranscriptEntry) {
  return `${entry.line} ${entry.source}: ${entry.text}`
}

export const HistoryGrepTool = Tool.define(
  "history_grep",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return {
      description:
        "Search folded conversation history (original user messages, assistant text, tool calls and outputs) by fixed string. Only available when chunk compaction checkpoints exist. Reasoning, provider metadata and binary attachments are never searched.",
      parameters: GrepParameters,
      execute: (params: Schema.Schema.Type<typeof GrepParameters>, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult<GrepMeta>> =>
        loadChunkCtx(sessions, ctx.sessionID).pipe(
          Effect.flatMap((chunkCtx) => {
            if (!chunkCtx) {
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
              headLimit: params.head_limit ?? 20,
            })
            if (hits.length === 0) {
              return Effect.succeed({ title: params.pattern, metadata: { matches: 0 }, output: "No matches in folded history." })
            }
            const output = hits
              .map((hit) => {
                const context = hit.context
                  .map((entry) => `  ${entry.line} ${entry.source}: ${entry.text}`)
                  .join("\n")
                return [
                  `chunk ${hit.chunk.display_id} (sequence ${hit.chunk.sequence}) ${hit.source} line ${hit.line}:`,
                  `  ${hit.text}`,
                  `  context:`,
                  context,
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
        "List a deterministic normalized transcript of a folded chunk by its 8-character display ID. Use history_grep first to locate the chunk and line range. Output is plain transcript lines, subject to normal tool truncation.",
      parameters: ListParameters,
      execute: (params: Schema.Schema.Type<typeof ListParameters>, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult<ListMeta>> =>
        loadChunkCtx(sessions, ctx.sessionID).pipe(
          Effect.flatMap((chunkCtx) => {
            if (!chunkCtx) {
              return Effect.succeed({
                title: params.chunk_id,
                metadata: { lines: 0 },
                output: "No folded history available (no chunk checkpoints in this session).",
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
            const offset = params.offset ?? 0
            const limit = params.limit ?? 80
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
              output: slice.map(formatEntry).join("\n"),
            })
          }),
        ),
    }
  }),
)
