export * as ProjectV2 from "./project"
export * as Project from "./project"

import { Context, Effect, Layer, Schema } from "effect"
import path from "path"
import { AbsolutePath } from "./schema"
import { FSUtil } from "./fs-util"
import { makeGlobalNode } from "./effect/app-node"
import { Hash } from "./util/hash"
import { ProjectDirectories } from "./project/directories"
import { ProjectSchema } from "./project/schema"

export const ID = ProjectSchema.ID
export type ID = ProjectSchema.ID

export const Vcs = ProjectSchema.Vcs
export type Vcs = ProjectSchema.Vcs

export class Info extends Schema.Class<Info>("Project.Info")({
  id: ID,
}) {}

export const DirectoriesInput = ProjectDirectories.ListInput
export type DirectoriesInput = typeof DirectoriesInput.Type

export const Directories = ProjectDirectories.ListOutput
export type Directories = typeof Directories.Type

export interface Resolved {
  readonly previous?: ID
  readonly id: ID
  readonly directory: AbsolutePath
  readonly vcs?: Vcs
}

export interface Interface {
  readonly directories: (input: DirectoriesInput) => Effect.Effect<Directories>
  readonly resolve: (input: AbsolutePath) => Effect.Effect<Resolved>
  /**
   * Temporary bridge method for writing the resolved project ID to the repo-local cache.
   *
   * This exists while the old opencode project service and this core project
   * service work together: core resolves the ID, while the old service still owns
   * database migration and persistence. The old service should call this after it
   * finishes migrating from `resolve().previous` to `resolve().id`; once project
   * persistence moves into core, this separate bridge method can go away.
   */
  readonly commit: (input: { store: AbsolutePath; id: ID }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProjectV2") {}

// Project ID derivation: pure path-based, no git subprocess.
// `.git/opencode` file is still read for backward-compat with projects that
// were previously hashed from remote URL or root commit.
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const projectDirectories = yield* ProjectDirectories.Service

    const directories = Effect.fn("Project.directories")(function* (input: DirectoriesInput) {
      return yield* projectDirectories.list(input.projectID)
    })

    const cached = Effect.fnUntraced(function* (dir: string) {
      return yield* fs.readFileString(path.join(dir, "opencode")).pipe(
        Effect.map((value) => value.trim()),
        Effect.map((value) => (value ? ID.make(value) : undefined)),
        Effect.catch(() => Effect.succeed(undefined)),
      )
    })

    // Walk up from `dir` until a `.git` entry is found (or filesystem root).
    // `.git` is either a directory (normal repo) or a text file containing
    // `gitdir: <path>` (linked worktree). We try reading it as a file first;
    // on EISDIR we know it's a real directory.
    const findGitRoot = Effect.fnUntraced(function* (dir: AbsolutePath) {
      let current = dir as string
      while (true) {
        const gitPath = path.join(current, ".git")
        const content = yield* fs.readFileStringSafe(gitPath).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        )
        if (content === undefined) {
          // Either missing or a directory — check exists to distinguish
          const exists = yield* fs.existsSafe(gitPath).pipe(Effect.orDie)
          if (exists) {
            // `.git` is a directory — this is the repo root
            return { worktree: AbsolutePath.make(current), commonDirectory: AbsolutePath.make(gitPath) }
          }
          const parent = path.dirname(current)
          if (parent === current) return undefined
          current = parent
          continue
        }
        // `.git` is a file — worktree pointer containing `gitdir: <path>`
        const match = content.match(/^gitdir:\s*(.+)$/m)
        if (!match) return { worktree: AbsolutePath.make(current), commonDirectory: AbsolutePath.make(gitPath) }
        const gitdir = match[1].trim()
        const resolved = path.isAbsolute(gitdir) ? gitdir : path.resolve(current, gitdir)
        return { worktree: AbsolutePath.make(current), commonDirectory: AbsolutePath.make(resolved) }
      }
    })

    const resolve = Effect.fn("Project.resolve")(function* (input: AbsolutePath) {
      const gitRoot = yield* findGitRoot(input)
      if (!gitRoot) return { id: ID.global, directory: AbsolutePath.make(path.parse(input).root), vcs: undefined }

      const previous = yield* cached(gitRoot.commonDirectory)
      const id = previous ?? ID.make(Hash.fast(`dir:${gitRoot.worktree}`))
      return {
        previous,
        id,
        directory: gitRoot.worktree,
        vcs: { type: "git" as const, store: gitRoot.commonDirectory },
      }
    })

    const commit = Effect.fn("Project.commit")(function* (input: { store: AbsolutePath; id: ID }) {
      yield* fs.writeFileString(path.join(input.store, "opencode"), input.id).pipe(Effect.ignore)
    })

    return Service.of({ directories, resolve, commit })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, ProjectDirectories.node],
})
