import { normalize, type ViewDiff } from "./session-diff"
import { Patch } from "@opencode-ai/core/patch"
import { diffLines } from "diff"

type Kind = "add" | "update" | "delete" | "move"

type Raw = {
  filePath?: string
  relativePath?: string
  type?: Kind
  patch?: string
  diff?: string
  before?: string
  after?: string
  additions?: number
  deletions?: number
  movePath?: string
}

export type ApplyPatchFile = {
  filePath: string
  relativePath: string
  type: Kind
  additions: number
  deletions: number
  movePath?: string
  view: ViewDiff
}

function kind(value: unknown) {
  if (value === "add" || value === "update" || value === "delete" || value === "move") return value
}

function status(type: Kind): "added" | "deleted" | "modified" {
  if (type === "add") return "added"
  if (type === "delete") return "deleted"
  return "modified"
}

export function patchFile(raw: unknown): ApplyPatchFile | undefined {
  if (!raw || typeof raw !== "object") return

  const value = raw as Raw
  const type = kind(value.type)
  const filePath = typeof value.filePath === "string" ? value.filePath : undefined
  const relativePath = typeof value.relativePath === "string" ? value.relativePath : filePath
  const patch = typeof value.patch === "string" ? value.patch : typeof value.diff === "string" ? value.diff : undefined
  const before = typeof value.before === "string" ? value.before : undefined
  const after = typeof value.after === "string" ? value.after : undefined

  if (!type || !filePath || !relativePath) return
  if (!patch && before === undefined && after === undefined) return

  const additions = typeof value.additions === "number" ? value.additions : 0
  const deletions = typeof value.deletions === "number" ? value.deletions : 0
  const movePath = typeof value.movePath === "string" ? value.movePath : undefined

  return {
    filePath,
    relativePath,
    type,
    additions,
    deletions,
    movePath,
    view: normalize({
      file: relativePath,
      patch,
      before,
      after,
      additions,
      deletions,
      status: status(type),
    }),
  }
}

export function patchFiles(raw: unknown) {
  if (!Array.isArray(raw)) return []
  return raw.map(patchFile).filter((file): file is ApplyPatchFile => !!file)
}

export function pendingPatchFiles(tool: string, input: Record<string, unknown>) {
  const files: Raw[] = []
  if (tool === "apply_patch" && typeof input.patchText === "string") {
    // 预览复用补丁语法，但只投影已收到的内容，不读取或修改磁盘文件。
    try {
      for (const hunk of Patch.parse(input.patchText, { partial: true })) {
        files.push({
          filePath: hunk.path,
          type: hunk.type === "update" && hunk.movePath ? "move" : hunk.type,
          movePath: hunk.type === "update" ? hunk.movePath : undefined,
          before: hunk.type === "update" ? hunk.chunks.flatMap((chunk) => chunk.oldLines).join("\n") : "",
          after:
            hunk.type === "add"
              ? hunk.contents
              : hunk.type === "update"
                ? hunk.chunks.flatMap((chunk) => chunk.newLines).join("\n")
                : "",
        })
      }
    } catch {
      // 尚不能构成合法片段时保持空卡片；正式工具执行仍负责严格校验。
    }
  }
  if (tool === "multiedit" && Array.isArray(input.edits)) {
    for (const edit of input.edits) {
      if (!edit || typeof edit !== "object" || typeof edit.filePath !== "string") continue
      files.push({
        filePath: edit.filePath,
        type: "update",
        before: typeof edit.oldString === "string" ? edit.oldString : "",
        after: typeof edit.newString === "string" ? edit.newString : "",
      })
    }
  }
  return files.flatMap((file) => {
    const changes = diffLines(file.before ?? "", file.after ?? "")
    const projected = patchFile({
      ...file,
      additions: changes.reduce((count, change) => count + (change.added ? change.count : 0), 0),
      deletions: changes.reduce((count, change) => count + (change.removed ? change.count : 0), 0),
    })
    if (!projected) return []
    // 更新类参数只有变更片段，不冒充完整文件；完成后由服务端的真实 Diff 接管。
    if (file.type !== "add") projected.view.fileDiff = { ...projected.view.fileDiff, isPartial: true }
    return [projected]
  })
}
