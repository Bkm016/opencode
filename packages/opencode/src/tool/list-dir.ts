import path from "path"
import { Effect, Schema } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./list-dir.txt"
import { InputAlias } from "./input-aliases"
import * as Tool from "./tool"
import { resolveInputPath } from "@/util/filesystem"

const DEFAULT_LIMIT = 2000

export const Parameters = Schema.Struct({
  path: Schema.optional(Schema.String).annotate({
    description:
      "Directory path to list. Relative paths resolve from the project directory. Defaults to the project directory. Absolute paths outside the project require external_directory approval.",
  }),
  offset: Schema.optional(NonNegativeInt).annotate({
    description: "The 1-based directory entry offset to start listing from (default 1)",
  }),
  limit: Schema.optional(NonNegativeInt).annotate({
    description: `The maximum number of directory entries to return (defaults to ${DEFAULT_LIMIT})`,
  }),
})

type Metadata = {
  count: number
  truncated: boolean
  offset: number
  totalEntries: number
}

export const ListDirTool = Tool.define(
  "list_dir",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service

    const entries = Effect.fn("ListDirTool.entries")(function* (filepath: string) {
      const items = yield* fs.readDirectoryEntries(filepath)
      return yield* Effect.forEach(
        items,
        Effect.fnUntraced(function* (item) {
          if (item.type === "directory") return item.name + "/"
          if (item.type !== "symlink") return item.name
          const target = yield* fs.stat(path.join(filepath, item.name)).pipe(Effect.catch(() => Effect.void))
          if (target?.type === "Directory") return item.name + "/"
          return item.name
        }),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((items: string[]) => items.sort((a, b) => a.localeCompare(b))))
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      // Accepted at the execute boundary only; model-facing schema stays canonical.
      inputAliases: InputAlias.listDir,
      nameAliases: ["list", "listdir", "ls", "LS", "ListDir"],
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
           const filepath = resolveInputPath(ins.directory, params.path?.trim() ? params.path : ins.directory)

          const stat = yield* fs.stat(filepath).pipe(
            Effect.catchIf(
              (err) => "reason" in err && err.reason._tag === "NotFound",
              () => Effect.succeed(undefined),
            ),
          )
          if (!stat) return yield* Effect.fail(new Error(`Directory not found: ${filepath}`))
          if (stat.type !== "Directory") return yield* Effect.fail(new Error(`Path is not a directory: ${filepath}`))

          yield* assertExternalDirectoryEffect(ctx, filepath, { kind: "directory" })
          yield* ctx.ask({
            permission: "list",
            patterns: [path.relative(ins.worktree, filepath) || "."],
            always: ["*"],
            metadata: {
              path: filepath,
            },
          })

          const items = yield* entries(filepath)
          const limit = params.limit ?? DEFAULT_LIMIT
          const offset = params.offset || 1
          const start = Math.max(0, offset - 1)
          const sliced = items.slice(start, start + limit)
          const truncated = start + sliced.length < items.length
          const title = path.relative(ins.worktree, filepath) || "."

          const lines =
            sliced.length === 0
              ? ["No entries"]
              : [
                  ...sliced,
                  ...(truncated
                    ? ["", `(Truncated. Showing ${sliced.length} of ${items.length}. next offset=${offset + sliced.length})`]
                    : []),
                ]

          return {
            title,
            output: lines.join("\n"),
            metadata: {
              count: sliced.length,
              truncated,
              offset,
              totalEntries: items.length,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
