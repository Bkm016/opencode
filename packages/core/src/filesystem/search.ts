export * as FileSystemSearch from "./search"

import { makeLocationNode } from "../effect/app-node"
import path from "path"
import fsp from "fs/promises"
import { Context, Effect, Fiber, Layer, Scope } from "effect"
import { Fff } from "#fff"
import fuzzysort from "fuzzysort"
import { FileSystem } from "../filesystem"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { Ripgrep } from "../ripgrep"
import { RelativePath } from "../schema"
import { Flag } from "../flag/flag"

export interface Interface {
  readonly find: (input: FileSystem.FindInput) => Effect.Effect<FileSystem.Entry[]>
  readonly glob: (input: FileSystem.GlobInput) => Effect.Effect<readonly FileSystem.Entry[]>
  readonly grep: (input: FileSystem.GrepInput) => Effect.Effect<readonly FileSystem.Match[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/FileSystem/Search") {}

// 文件名列表的上限：只存路径，内存可控
const LIST_LIMIT = 200_000

const makeRipgrep = Effect.gen(function* () {
  const fs = yield* FSUtil.Service
  const location = yield* Location.Service
  const ripgrep = yield* Ripgrep.Service
  const scope = yield* Scope.Scope
  const state = {
    files: [] as string[],
    directories: [] as string[],
  }
  const directories = new Set<string>()
  // 第一次搜索时才列文件：打开终端、跑会话等也会启动目录服务，不该顺带把整棵树扫一遍
  const scan = yield* Effect.cached(
    ripgrep
      .find({
        cwd: location.directory,
        pattern: "*",
        limit: LIST_LIMIT,
        onEntry: (entry) =>
          Effect.sync(() => {
            state.files.push(entry.path)
            const parts = entry.path.split("/")
            parts.slice(0, -1).forEach((_, index) => directories.add(parts.slice(0, index + 1).join("/") + path.sep))
            state.directories = Array.from(directories)
          }),
      })
      .pipe(Effect.orDie, Effect.asVoid, Effect.forkIn(scope)),
  )
  return Service.of({
    glob: (input) =>
      Effect.gen(function* () {
        const target = path.resolve(location.directory, input.path ?? ".")
        const info = yield* fs.stat(target).pipe(Effect.orDie)
        const cwd = info.type === "File" ? path.dirname(target) : target
        return yield* ripgrep
          .glob({
            cwd,
            pattern: input.pattern,
            limit: input.limit ?? Number.MAX_SAFE_INTEGER,
          })
          .pipe(
            Effect.map((result) =>
              result.map((entry) =>
                FileSystem.Entry.make({
                  ...entry,
                  path: RelativePath.make(path.relative(location.directory, path.resolve(cwd, entry.path))),
                }),
              ),
            ),
            Effect.orDie,
          )
      }),
    grep: (input) =>
      Effect.gen(function* () {
        const target = path.resolve(location.directory, input.path ?? ".")
        const info = yield* fs.stat(target).pipe(Effect.orDie)
        const cwd = info.type === "File" ? path.dirname(target) : target
        return yield* ripgrep
          .grep({
            cwd,
            pattern: input.pattern,
            file: info.type === "File" ? path.basename(target) : undefined,
            include: input.include,
            limit: input.limit ?? Number.MAX_SAFE_INTEGER,
          })
          .pipe(
            Effect.map((result) =>
              result.map((match) =>
                FileSystem.Match.make({
                  ...match,
                  entry: FileSystem.Entry.make({
                    ...match.entry,
                    path: RelativePath.make(path.relative(location.directory, path.resolve(cwd, match.entry.path))),
                  }),
                }),
              ),
            ),
            Effect.orDie,
          )
      }),
    find: (input) =>
      Effect.gen(function* () {
        const fiber = yield* scan
        // 首次搜索稍等一下扫描结果，避免第一次总是空的
        if (state.files.length === 0) yield* Fiber.await(fiber).pipe(Effect.timeout(1_000), Effect.ignore)
        const items =
          input.type === "file"
            ? state.files
            : input.type === "directory"
              ? state.directories
              : [...state.files, ...state.directories]
        return fuzzysort.go(input.query, items, { limit: input.limit ?? 50 }).map((item) => {
          const relative = item.target
          const type = relative.endsWith(path.sep) ? ("directory" as const) : ("file" as const)
          return FileSystem.Entry.make({
            path: RelativePath.make(relative),
            type,
          })
        })
      }),
  })
})

export const ripgrepLayer = Layer.effect(Service, makeRipgrep)

// fff 建索引时会把每个不超过约 10MB 的文件完整读一遍（更大的跳过）。
// 先只看文件名和大小估一下，这些文件加起来太多就不用 fff，免得把磁盘读爆。
const FFF_MAX_FILES = 100_000
const FFF_MAX_FILE_BYTES = 16 * 1024 * 1024
const FFF_MAX_TOTAL_BYTES = 1024 * 1024 * 1024

const fffFits = Effect.fn("FileSystemSearch.fffFits")(function* (ripgrep: Ripgrep.Interface, directory: string) {
  const entries = yield* ripgrep
    .find({ cwd: directory, pattern: "*", hidden: true, limit: FFF_MAX_FILES + 1 })
    .pipe(Effect.orElseSucceed(() => undefined))
  if (!entries || entries.length > FFF_MAX_FILES) return false
  let total = 0
  for (let index = 0; index < entries.length; index += 256) {
    const sizes = yield* Effect.promise(() =>
      Promise.all(
        entries.slice(index, index + 256).map((entry) =>
          fsp.stat(path.join(directory, entry.path)).then(
            (info) => (info.size <= FFF_MAX_FILE_BYTES ? info.size : 0),
            () => 0,
          ),
        ),
      ),
    )
    total += sizes.reduce((sum, size) => sum + size, 0)
    if (total > FFF_MAX_TOTAL_BYTES) return false
  }
  return true
})

export const fffLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const location = yield* Location.Service
    const ripgrep = yield* Ripgrep.Service
    const fallback = yield* makeRipgrep
    // 第一次搜索时才创建，不在目录服务启动时就扫
    let picker: Fff.Picker | undefined
    yield* Effect.addFinalizer(() => Effect.sync(() => picker?.destroy()).pipe(Effect.ignore))
    const load = yield* Effect.cached(
      Effect.gen(function* () {
        if (!(yield* fffFits(ripgrep, location.directory))) {
          yield* Effect.logInfo("directory too large for fff, using ripgrep", { directory: location.directory })
          return undefined
        }
        const result = yield* Effect.try({
          try: () =>
            Fff.create({
              basePath: location.directory,
              aiMode: true,
              disableMmapCache: true,
              disableContentIndexing: true,
            }),
          catch: (cause) => cause,
        }).pipe(
          Effect.catch((error) => Effect.logWarning("failed to initialize fff", { error }).pipe(Effect.as(undefined))),
        )
        if (!result?.ok) {
          if (result) yield* Effect.logWarning("failed to initialize fff", { error: result.error })
          return undefined
        }
        picker = result.value
        // 首次搜索稍等一下扫描结果，避免第一次总是空的
        yield* Effect.promise(() => result.value.waitForScan(1_000)).pipe(Effect.ignore)
        return result.value
      }),
    )
    const use = <A>(otherwise: Effect.Effect<A>, run: (picker: Fff.Picker) => A) =>
      load.pipe(Effect.flatMap((picker) => (picker ? Effect.sync(() => run(picker)) : otherwise)))
    return Service.of({
      glob: (input) =>
        use(fallback.glob(input), (picker) => {
          const prefix = input.path?.replaceAll("\\", "/").replace(/\/$/, "")
          const found = picker.glob(prefix ? `${prefix}/${input.pattern}` : input.pattern, {
            pageIndex: 0,
            pageSize: input.limit,
          })
          if (!found.ok) throw found.error
          return found.value.items.map((item) =>
            FileSystem.Entry.make({
              path: RelativePath.make(item.relativePath.replaceAll("\\", "/")),
              type: "file",
            }),
          )
        }),
      grep: (input) =>
        use(fallback.grep(input), (picker) => {
          const prefix = input.path?.replaceAll("\\", "/").replace(/\/$/, "")
          const found = picker.grep(
            [prefix ? `${prefix}/**` : undefined, input.include, input.pattern]
              .filter((value) => value !== undefined)
              .join(" "),
            { mode: "regex", pageSize: input.limit, timeBudgetMs: 1_500 },
          )
          if (!found.ok) throw found.error
          return found.value.items.map((match) => {
            const bytes = Buffer.from(match.lineContent)
            return FileSystem.Match.make({
              entry: FileSystem.Entry.make({
                path: RelativePath.make(match.relativePath.replaceAll("\\", "/")),
                type: "file",
              }),
              line: match.lineNumber,
              offset: match.byteOffset,
              text: match.lineContent.length > 2_000 ? match.lineContent.slice(0, 2_000) + "..." : match.lineContent,
              submatches: match.matchRanges.map(([start, end]) => ({
                text: bytes.subarray(start, end).toString("utf8"),
                start,
                end,
              })),
            })
          })
        }),
      find: (input) =>
        use(fallback.find(input), (picker) => {
          const options = { pageIndex: 0, pageSize: input.limit ?? 50 }
          const items = (() => {
            if (input.type === "file") {
              const found = picker.fileSearch(input.query.trim(), options)
              if (!found.ok) throw found.error
              return found.value.items.map((item, index) => ({
                path: item.relativePath,
                type: "file" as const,
                score: found.value.scores[index]?.total ?? 0,
              }))
            }
            if (input.type === "directory") {
              const found = picker.directorySearch(input.query.trim(), options)
              if (!found.ok) throw found.error
              return found.value.items.map((item, index) => ({
                path: item.relativePath,
                type: "directory" as const,
                score: found.value.scores[index]?.total ?? 0,
              }))
            }
            const found = picker.mixedSearch(input.query.trim(), options)
            if (!found.ok) throw found.error
            return found.value.items.map((item, index) => ({
              path: item.item.relativePath,
              type: item.type,
              score: found.value.scores[index]?.total ?? 0,
            }))
          })()
          return items
            .sort((a, b) => b.score - a.score || a.path.length - b.path.length)
            .map((item) => {
              const relative = item.path.replaceAll("\\", "/").replace(/\/$/, "")
              return FileSystem.Entry.make({
                path: RelativePath.make(relative + (item.type === "directory" ? path.sep : "")),
                type: item.type,
              })
            })
        }),
    })
  }),
)

// 不是仓库的目录（比如存档、整盘挂载点）没有忽略规则，直接用 ripgrep 只列文件名；仓库也要先过 fffFits 才用 fff
const layer = Layer.unwrap(
  Effect.gen(function* () {
    if (Flag.OPENCODE_DISABLE_FFF || !Fff.available()) return ripgrepLayer
    return (yield* Location.Service).vcs ? fffLayer : ripgrepLayer
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [FSUtil.node, Location.node, Ripgrep.node] })
