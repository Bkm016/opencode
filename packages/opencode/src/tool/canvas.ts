import { Effect, Option, Schema } from "effect"
import path from "path"
import { Tool } from "./tool"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { resolveInputPath } from "@/util/filesystem"
import DESCRIPTION from "./canvas.txt"

// Canvas 文档大小限制：最大 UTF-8 256 KiB
export const MAX_CANVAS_BYTES = 256 * 1024

export class CanvasBoundaryError extends Schema.TaggedErrorClass<CanvasBoundaryError>()("CanvasBoundaryError", {
  message: Schema.String,
}) {}

export const Parameters = Schema.Struct({
  path: Schema.String.annotate({
    description:
      "The path of the Markdown file to display on the canvas (must be a .md or .markdown file within the current project)",
  }),
  title: Schema.optional(Schema.String).annotate({
    description: "Optional display title for the canvas. Defaults to the file name.",
  }),
})

export const CanvasMetadata = Schema.Struct({
  path: Schema.String,
  canonicalPath: Schema.String,
  title: Schema.String,
  content: Schema.String,
})
export type CanvasMetadata = Schema.Schema.Type<typeof CanvasMetadata>

/**
 * 统一执行 Canvas 目标文件校验、授权与有界读取：
 * 1. 路径处于当前 workspace/project 内
 * 2. 目标为存在的普通文件且为 .md 或 .markdown
 * 3. 严格解析真实物理路径（fail-closed），拒绝符号链接越界访问项目外文件
 * 4. 若传入 expectedCanonicalPath，必须严格匹配同一物理文件，严防符号链接换向扩大授权
 * 5. 校验 stat 大小不超过 256 KiB
 * 6. 执行 options.authorize 授权回调（先授权后读取，禁止先无界读入再拒绝）
 * 7. 采用 canonical 真实路径通过 fs.open / readAlloc(MAX+1) 进行 scoped 有界读取，末尾二次确认 realPath
 */
export const readCanvasFile = Effect.fn("Canvas.readCanvasFile")(function* (
  fs: FSUtil.Interface,
  instance: InstanceContext,
  inputPath: string,
  options?: {
    title?: string
    expectedCanonicalPath?: string
    authorize?: (paths: { filepath: string; canonicalPath: string }) => Effect.Effect<void, CanvasBoundaryError>
  },
) {
  const filepath = resolveInputPath(instance.directory, inputPath)

  if (!containsPath(filepath, instance)) {
    return yield* new CanvasBoundaryError({
      message: `Access denied: file path is outside the current project workspace: ${filepath}`,
    })
  }

  const exists = yield* fs.existsSafe(filepath)
  if (!exists) {
    return yield* new CanvasBoundaryError({
      message: `File not found: ${filepath}`,
    })
  }

  const isFile = yield* fs.isFile(filepath)
  if (!isFile) {
    return yield* new CanvasBoundaryError({
      message: `Path is not a regular file: ${filepath}`,
    })
  }

  const ext = path.extname(filepath).toLowerCase()
  if (ext !== ".md" && ext !== ".markdown") {
    return yield* new CanvasBoundaryError({
      message: `Only Markdown files (.md or .markdown) are supported on the canvas: ${filepath}`,
    })
  }

  // 严格解析真实规范物理路径（fail-closed），绝不吞掉错误放行
  const canonical = yield* fs.realPath(filepath).pipe(
    Effect.catch(() =>
      Effect.fail(
        new CanvasBoundaryError({
          message: `Failed to resolve canonical path for: ${filepath}`,
        }),
      ),
    ),
  )
  const canonicalPath = FSUtil.normalizePath(canonical)
  if (!containsPath(canonicalPath, instance)) {
    return yield* new CanvasBoundaryError({
      message: `Access denied: symlink target resolves outside the current project workspace: ${filepath}`,
    })
  }

  // 若提供预期 canonicalPath，必须严格匹配同一物理文件，严防符号链接换向
  if (options?.expectedCanonicalPath && options.expectedCanonicalPath !== canonicalPath) {
    return yield* new CanvasBoundaryError({
      message: `Access denied: canonical path changed from ${options.expectedCanonicalPath} to ${canonicalPath}`,
    })
  }

  // 校验文件大小上限（256 KiB）
  const stat = yield* fs.stat(canonicalPath).pipe(
    Effect.catch(() =>
      Effect.fail(
        new CanvasBoundaryError({
          message: `Failed to stat file: ${canonicalPath}`,
        }),
      ),
    ),
  )
  if (Number(stat.size) > MAX_CANVAS_BYTES) {
    return yield* new CanvasBoundaryError({
      message: `File is too large for canvas (${stat.size} bytes). Maximum allowed size is 256 KB.`,
    })
  }

  const normalizedPath = FSUtil.normalizePath(filepath)

  // 先授权再读取：必须在打开和读取文件正文前完成授权校验
  if (options?.authorize) {
    yield* options.authorize({ filepath: normalizedPath, canonicalPath })
  }

  // 采用 canonical 真实路径进行 scoped 有界读取（读取 MAX+1 字节，防止无界读入大文件）
  const chunk = yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(canonicalPath, { flag: "r" }).pipe(
        Effect.catch(() =>
          Effect.fail(
            new CanvasBoundaryError({
              message: `Failed to open file: ${canonicalPath}`,
            }),
          ),
        ),
      )
      // readAlloc 允许短读，循环至 EOF 或上限，不能把一次短读当成完整文档。
      const chunks: Uint8Array[] = []
      let size = 0
      while (size <= MAX_CANVAS_BYTES) {
        const allocated = yield* file
          .readAlloc(MAX_CANVAS_BYTES + 1 - size)
          .pipe(
            Effect.catch(() =>
              Effect.fail(new CanvasBoundaryError({ message: `Failed to read file: ${canonicalPath}` })),
            ),
          )
        if (Option.isNone(allocated) || allocated.value.byteLength === 0) break
        chunks.push(allocated.value)
        size += allocated.value.byteLength
      }
      return Buffer.concat(chunks, size)
    }),
  )

  if (chunk.byteLength > MAX_CANVAS_BYTES) {
    return yield* new CanvasBoundaryError({
      message: `File content exceeds 256 KB UTF-8 limit (${chunk.byteLength} bytes).`,
    })
  }

  // 二次确认真实物理路径未在读取期间发生并发替换或换向
  const verifyCanonical = yield* fs.realPath(canonicalPath).pipe(
    Effect.catch(() =>
      Effect.fail(
        new CanvasBoundaryError({
          message: `Failed to re-verify canonical path for: ${canonicalPath}`,
        }),
      ),
    ),
  )
  if (FSUtil.normalizePath(verifyCanonical) !== canonicalPath) {
    return yield* new CanvasBoundaryError({
      message: `Access denied: canonical path changed concurrently for: ${canonicalPath}`,
    })
  }

  const decoder = new TextDecoder("utf-8", { fatal: true })
  const content = yield* Effect.try({
    try: () => decoder.decode(chunk),
    catch: () =>
      new CanvasBoundaryError({
        message: `File content is not valid UTF-8 text: ${canonicalPath}`,
      }),
  })

  const displayTitle = options?.title?.trim() || path.basename(filepath)

  return {
    filepath: normalizedPath,
    canonicalPath,
    title: displayTitle,
    content,
  }
})

export const CanvasTool = Tool.define(
  "canvas",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service

    const run = Effect.fn("CanvasTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<CanvasMetadata>,
    ) {
      const instance = yield* InstanceState.context
      // 执行统一的 Canvas 读取与边界校验（在打开文件前通过 authorize 回调授权）
      const file = yield* readCanvasFile(fs, instance, params.path, {
        title: params.title,
        authorize: ({ filepath, canonicalPath }) =>
          ctx.ask({
            permission: "read",
            patterns: [path.relative(instance.worktree, filepath), path.relative(instance.worktree, canonicalPath)],
            always: ["*"],
            metadata: {},
          }),
      }).pipe(Effect.catch((err) => Effect.fail(new Error(err.message))))

      // 输出简短摘要，metadata 固化规范路径、真实物理路径与内容快照
      return {
        title: file.title,
        output: `Opened canvas for ${file.title} (${file.filepath})`,
        metadata: {
          path: file.filepath,
          canonicalPath: file.canonicalPath,
          title: file.title,
          content: file.content,
        },
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: run,
    }
  }),
)
