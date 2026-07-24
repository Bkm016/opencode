import * as path from "path"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { Effect, Schema } from "effect"
import { createTwoFilesPatch, diffLines } from "diff"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { Format } from "../format"
import { LSP } from "@/lsp/lsp"
import * as Bom from "@/util/bom"
import { assertExternalDirectoryEffect } from "./external-directory"
import { replace, trimDiff } from "./edit"
import { InputAlias } from "./input-aliases"
import DESCRIPTION from "./multiedit.txt"
import * as Tool from "./tool"

type EntryInput = {
  filePath: string
  oldString: string
  newString: string
  replaceAll?: boolean
}

// Loose decode so per-entry aliases can be remapped in normalizeEntry.
export const Parameters = Schema.Struct({
  edits: Schema.Array(Schema.Unknown).annotate({
    description: "Ordered list of string replacements to apply",
  }),
})

const JSON_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {
    edits: {
      type: "array",
      description: "Ordered list of string replacements to apply",
      items: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "The absolute path to the file to modify" },
          oldString: { type: "string", description: "The text to replace" },
          newString: {
            type: "string",
            description: "The text to replace it with (must be different from oldString)",
          },
          replaceAll: {
            type: "boolean",
            description: "Replace all occurrences of oldString (default false)",
          },
        },
        required: ["filePath", "oldString", "newString"],
      },
    },
  },
  required: ["edits"],
}

type FileChange = {
  filePath: string
  relativePath: string
  type: "add" | "update"
  patch: string
  additions: number
  deletions: number
  oldContent: string
  newContent: string
  bom: boolean
}

function normalizeEntry(raw: unknown, index: number): EntryInput {
  const next = Tool.applyInputAliases(raw, InputAlias.multiEditEntry)
  if (!next || typeof next !== "object" || Array.isArray(next)) {
    throw new Error(`edits[${index}]: expected an object`)
  }
  const entry = next as Record<string, unknown>
  if (typeof entry.filePath !== "string" || !entry.filePath) {
    throw new Error(`edits[${index}]: filePath is required`)
  }
  if (typeof entry.oldString !== "string") {
    throw new Error(`edits[${index}]: oldString is required`)
  }
  if (typeof entry.newString !== "string") {
    throw new Error(`edits[${index}]: newString is required`)
  }
  if (entry.replaceAll !== undefined && typeof entry.replaceAll !== "boolean") {
    throw new Error(`edits[${index}]: replaceAll must be a boolean`)
  }
  return {
    filePath: entry.filePath,
    oldString: entry.oldString,
    newString: entry.newString,
    ...(typeof entry.replaceAll === "boolean" ? { replaceAll: entry.replaceAll } : {}),
  }
}

function normalizeLineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n")
}

function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n"
}

function convertToLineEnding(text: string, ending: "\n" | "\r\n"): string {
  if (ending === "\n") return text
  return text.replaceAll("\n", "\r\n")
}

export const MultiEditTool = Tool.define(
  "multiedit",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* FSUtil.Service
    const format = yield* Format.Service
    const events = yield* EventV2Bridge.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      jsonSchema: JSON_SCHEMA,
      // Accepted at the execute boundary only; model-facing schema stays canonical.
      inputAliases: InputAlias.multiEdit,
      nameAliases: ["multi_edit", "MultiEdit"],
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const edits = (params.edits ?? []).map((entry, index) => normalizeEntry(entry, index))
          if (edits.length === 0) throw new Error("edits must contain at least one replacement")

          const instance = yield* InstanceState.context
          const byFile = new Map<
            string,
            {
              relativePath: string
              existed: boolean
              bom: boolean
              original: string
              content: string
            }
          >()

          for (const [index, entry] of edits.entries()) {
            const filePath = path.isAbsolute(entry.filePath)
              ? entry.filePath
              : path.join(instance.directory, entry.filePath)
            yield* assertExternalDirectoryEffect(ctx, filePath)

            let state = byFile.get(filePath)
            if (!state) {
              const info = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (info?.type === "Directory") {
                throw new Error(`edits[${index}]: path is a directory, not a file: ${filePath}`)
              }
              if (!info) {
                if (entry.oldString !== "") {
                  throw new Error(`edits[${index}]: File ${filePath} not found`)
                }
                state = {
                  relativePath: path.relative(instance.worktree, filePath).replaceAll("\\", "/"),
                  existed: false,
                  bom: false,
                  original: "",
                  content: "",
                }
              } else {
                const source = yield* Bom.readFile(afs, filePath)
                state = {
                  relativePath: path.relative(instance.worktree, filePath).replaceAll("\\", "/"),
                  existed: true,
                  bom: source.bom,
                  original: source.text,
                  content: source.text,
                }
              }
              byFile.set(filePath, state)
            }

            if (entry.oldString === entry.newString) {
              throw new Error(`edits[${index}]: No changes to apply: oldString and newString are identical.`)
            }

            if (entry.oldString === "") {
              if (state.existed || state.content !== "") {
                throw new Error(
                  `edits[${index}]: oldString cannot be empty when editing an existing file. Provide the exact text to replace, or use write for an intentional full-file replacement.`,
                )
              }
              const next = Bom.split(entry.newString)
              state.bom = state.bom || next.bom
              state.content = next.text
              continue
            }

            const ending = detectLineEnding(state.content)
            const old = convertToLineEnding(normalizeLineEndings(entry.oldString), ending)
            const replacement = convertToLineEnding(normalizeLineEndings(entry.newString), ending)
            try {
              const next = Bom.split(replace(state.content, old, replacement, entry.replaceAll))
              state.bom = state.bom || next.bom
              state.content = next.text
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              throw new Error(`edits[${index}] (${state.relativePath}): ${message}`)
            }
          }

          const changes: FileChange[] = []
          for (const [filePath, state] of byFile) {
            if (state.original === state.content) continue
            const patch = trimDiff(
              createTwoFilesPatch(
                filePath,
                filePath,
                normalizeLineEndings(state.original),
                normalizeLineEndings(state.content),
              ),
            )
            let additions = 0
            let deletions = 0
            for (const change of diffLines(state.original, state.content)) {
              if (change.added) additions += change.count || 0
              if (change.removed) deletions += change.count || 0
            }
            changes.push({
              filePath,
              relativePath: state.relativePath,
              type: state.existed ? "update" : "add",
              patch,
              additions,
              deletions,
              oldContent: state.original,
              newContent: state.content,
              bom: state.bom,
            })
          }

          if (changes.length === 0) {
            throw new Error("No changes to apply: all edits left file contents unchanged.")
          }

          const files = changes.map((change) => ({
            filePath: change.filePath,
            relativePath: change.relativePath,
            type: change.type,
            patch: change.patch,
            additions: change.additions,
            deletions: change.deletions,
          }))
          const totalDiff = changes.map((change) => change.patch).join("\n")
          const relativePaths = changes.map((change) => change.relativePath)

          yield* ctx.ask({
            permission: "edit",
            patterns: relativePaths,
            always: ["*"],
            metadata: {
              filepath: relativePaths.join(", "),
              diff: totalDiff,
              files,
            },
          })

          for (const change of changes) {
            yield* afs.writeWithDirs(change.filePath, Bom.join(change.newContent, change.bom))
            if (yield* format.file(change.filePath)) {
              yield* Bom.syncFile(afs, change.filePath, change.bom)
            }
            yield* events.publish(FileSystem.Event.Edited, { file: change.filePath })
            yield* events.publish(Watcher.Event.Updated, {
              file: change.filePath,
              event: change.type === "add" ? "add" : "change",
            })
            yield* lsp.touchFile(change.filePath, "document")
          }

          const diagnostics = yield* lsp.diagnostics()
          const summary = changes
            .map((change) => `${change.type === "add" ? "A" : "M"} ${change.relativePath}`)
            .join("\n")
          let output = `Success. Updated the following files:\n${summary}`
          for (const change of changes) {
            const block = LSP.Diagnostic.report(
              change.filePath,
              diagnostics[FSUtil.normalizePath(change.filePath)] ?? [],
            )
            if (!block) continue
            output += `\n\nLSP errors detected in ${change.relativePath}, please fix:\n${block}`
          }

          return {
            title: `${changes.length} file${changes.length === 1 ? "" : "s"}`,
            metadata: {
              diff: totalDiff,
              files,
              diagnostics,
            },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
