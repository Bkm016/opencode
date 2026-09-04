export * as SkillCloud from "./skill-cloud"

import { SkillCloud } from "@opencode-ai/schema/skill-cloud"
import path from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { DeployKey } from "./deploy-key"
import { makeGlobalNode } from "./effect/app-node"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { AppProcess } from "./process"
import { Repository } from "./repository"
import { AbsolutePath } from "./schema"
import { EffectFlock } from "./util/effect-flock"

export const Status = SkillCloud.Status
export type Status = SkillCloud.Status

export const ConfigureInput = SkillCloud.ConfigureInput
export type ConfigureInput = SkillCloud.ConfigureInput

export const UpdateInput = SkillCloud.UpdateInput
export type UpdateInput = SkillCloud.UpdateInput

export const SyncInput = SkillCloud.SyncInput
export type SyncInput = SkillCloud.SyncInput

export const RemoveInput = SkillCloud.RemoveInput
export type RemoveInput = SkillCloud.RemoveInput

export class OperationError extends Schema.TaggedErrorClass<OperationError>()("SkillCloudOperationError", {
  reason: SkillCloud.ErrorReason,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return `Cloud skill operation failed: ${this.detail}`
  }
}

export interface Interface {
  readonly list: () => Effect.Effect<Status[], OperationError>
  readonly status: (name?: string) => Effect.Effect<Status, OperationError>
  readonly configure: (input: ConfigureInput) => Effect.Effect<Status, OperationError>
  readonly update: (input?: UpdateInput) => Effect.Effect<Status[], OperationError>
  readonly sync: (input?: SyncInput) => Effect.Effect<Status, OperationError>
  readonly remove: (input: RemoveInput) => Effect.Effect<Status[], OperationError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SkillCloud") {}

type GitResult = {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

const gitConfig = [
  "--no-optional-locks",
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.longpaths=true",
  "-c",
  "core.quotepath=false",
  "-c",
  "maintenance.auto=false",
  "-c",
  "gc.auto=0",
] as const

function sanitizeName(name: string) {
  const cleaned = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
  return cleaned || "skills"
}

function state(input: Pick<Status, "configured" | "changes" | "ahead" | "behind">): Status["state"] {
  if (!input.configured) return "unconfigured"
  if (input.changes > 0) return "modified"
  if (input.ahead > 0 && input.behind > 0) return "diverged"
  if (input.ahead > 0) return "ahead"
  if (input.behind > 0) return "behind"
  return "ready"
}

function sshRepository(repository: string) {
  return repository.startsWith("ssh://") || /^(?:[^@/\s]+@)[^:/\s]+:/.test(repository)
}

function errorReason(detail: string, fallback: SkillCloud.ErrorReason): SkillCloud.ErrorReason {
  if (
    /permission denied|authentication failed|could not read username|repository not found|publickey|could not read from remote repository|host key verification failed/i.test(
      detail,
    )
  ) {
    return "authentication"
  }
  if (/conflict|non-fast-forward|not possible to fast-forward|divergent|unrelated histories/i.test(detail)) {
    return "merge_conflict"
  }
  return fallback
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const appProcess = yield* AppProcess.Service
    const deployKey = yield* DeployKey.Service
    const flock = yield* EffectFlock.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const cloudRoot = AbsolutePath.make(path.join(global.config, "skills", "cloud"))
    const lock = `skill-cloud:${cloudRoot}`

    const locked = <A>(effect: Effect.Effect<A, OperationError>) =>
      effect.pipe(
        flock.withLock(lock),
        Effect.mapError((cause) =>
          cause instanceof OperationError
            ? cause
            : new OperationError({
                reason: "operation_failed",
                detail: "failed to acquire the cloud skill repository lock",
                cause,
              }),
        ),
      )

    const environment = Effect.fnUntraced(function* (repository?: string) {
      const base = { GIT_TERMINAL_PROMPT: "0" }
      if (!repository || !sshRepository(repository)) return base
      const key = yield* deployKey.get().pipe(
        Effect.mapError(
          (cause) =>
            new OperationError({
              reason: "authentication",
              detail: "the managed SSH deploy key is unavailable",
              cause,
            }),
        ),
      )
      const privateKey = key.privateKeyPath.replaceAll("\\", "/").replaceAll('"', '\\"')
      return {
        ...base,
        GIT_SSH_COMMAND: `ssh -i "${privateKey}" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new`,
      }
    })

    const run = Effect.fnUntraced(function* (cwd: string, args: string[], repository?: string) {
      const env = yield* environment(repository)
      const result = yield* appProcess
        .run(
          ChildProcess.make("git", [...gitConfig, ...args], {
            cwd,
            env,
            extendEnv: true,
            stdin: "ignore",
          }),
        )
        .pipe(
          Effect.mapError((cause) => {
            const reason = /enoent|not found/i.test(cause.message) ? "git_unavailable" : "operation_failed"
            return new OperationError({ reason, detail: cause.message, cause })
          }),
        )
      return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString("utf8"),
        stderr: result.stderr.toString("utf8"),
      } satisfies GitResult
    })

    const requireSuccess = Effect.fnUntraced(function* (
      result: GitResult,
      fallback: SkillCloud.ErrorReason = "operation_failed",
    ) {
      if (result.exitCode === 0) return result
      const detail = result.stderr.trim() || result.stdout.trim() || `git exited with code ${result.exitCode}`
      return yield* new OperationError({ reason: errorReason(detail, fallback), detail })
    })

    const remoteBranchExists = Effect.fnUntraced(function* (cwd: string, branch: string) {
      const result = yield* run(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`])
      return result.exitCode === 0
    })

    const defaultRemoteBranch = Effect.fnUntraced(function* (cwd: string) {
      yield* run(cwd, ["remote", "set-head", "origin", "--auto"]).pipe(Effect.ignore)
      const result = yield* run(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
      if (result.exitCode !== 0) return
      const value = result.stdout.trim()
      return value.startsWith("origin/") ? value.slice("origin/".length) : undefined
    })

    const inspectRepo = Effect.fnUntraced(function* (dir: string, name: string) {
      if (!(yield* fs.isDir(path.join(dir, ".git")))) {
        return SkillCloud.Status.make({
          name,
          state: "unconfigured",
          configured: false,
          directory: AbsolutePath.make(dir),
          changes: 0,
          ahead: 0,
          behind: 0,
        })
      }

      const origin = yield* run(dir, ["remote", "get-url", "origin"])
      const repository = origin.exitCode === 0 ? origin.stdout.trim() || undefined : undefined
      const branchResult = yield* run(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"])
      const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() || undefined : undefined
      const headResult = yield* run(dir, ["rev-parse", "--verify", "HEAD"])
      const head = headResult.exitCode === 0 ? headResult.stdout.trim() || undefined : undefined
      const changesResult = yield* requireSuccess(
        yield* run(dir, ["status", "--porcelain=v1", "--untracked-files=all", "-z", "--", "."]),
      )
      const changes = changesResult.stdout.split("\0").filter(Boolean).length
      const tracking = branch && (yield* remoteBranchExists(dir, branch))
      const counts = tracking
        ? yield* requireSuccess(yield* run(dir, ["rev-list", "--left-right", "--count", `origin/${branch}...HEAD`]))
        : undefined
      const [behind, ahead] = counts
        ? counts.stdout
            .trim()
            .split(/\s+/)
            .map((value) => Number.parseInt(value || "0", 10))
        : [0, 0]
      const configured = repository !== undefined
      const value = {
        configured,
        changes,
        ahead: Number.isFinite(ahead) ? ahead : 0,
        behind: Number.isFinite(behind) ? behind : 0,
      }
      return SkillCloud.Status.make({
        name,
        state: state(value),
        configured,
        ...(repository === undefined ? {} : { repository }),
        ...(branch === undefined ? {} : { branch }),
        directory: AbsolutePath.make(dir),
        ...(head === undefined ? {} : { head }),
        changes,
        ahead: value.ahead,
        behind: value.behind,
      })
    })

    const listRepos = Effect.fnUntraced(function* () {
      const results: Status[] = []
      const legacyGit = path.join(cloudRoot, ".git")
      if (yield* fs.isDir(legacyGit)) {
        results.push(yield* inspectRepo(cloudRoot, "default"))
      }

      if (yield* fs.isDir(cloudRoot)) {
        const entries = yield* fs.readDirectoryEntries(cloudRoot).pipe(Effect.catch(() => Effect.succeed([])))
        for (const entry of entries) {
          const entryName = entry.name
          if (entryName === ".git") continue
          const subDir = path.join(cloudRoot, entryName)
          if (yield* fs.isDir(path.join(subDir, ".git"))) {
            if (results.some((r) => r.name === entryName)) continue
            results.push(yield* inspectRepo(subDir, entryName))
          }
        }
      }

      return results.sort((a, b) => a.name.localeCompare(b.name))
    })

    const statusUnsafe = Effect.fnUntraced(function* (name?: string) {
      const all = yield* listRepos()
      if (name) {
        const target = all.find((r) => r.name === name)
        if (target) return target
        return yield* new OperationError({
          reason: "not_found",
          detail: `cloud skill repository "${name}" not found`,
        })
      }
      if (all.length > 0) return all[0]
      return SkillCloud.Status.make({
        name: "default",
        state: "unconfigured",
        configured: false,
        directory: cloudRoot,
        changes: 0,
        ahead: 0,
        behind: 0,
      })
    })

    const configureUnsafe = Effect.fnUntraced(function* (input: ConfigureInput) {
      const reference = Repository.parse(input.repository)
      if (!reference) {
        return yield* new OperationError({
          reason: "invalid_repository",
          detail: "repository must be a Git URL, host/path reference, or GitHub owner/repo shorthand",
        })
      }
      const repository = reference.remote
      const name = input.name ? sanitizeName(input.name) : sanitizeName(reference.repo)

      const all = yield* listRepos()
      const existing = all.find((r) => r.name === name)
      const targetDir = existing
        ? existing.directory
        : name === "default" && (yield* fs.isDir(path.join(cloudRoot, ".git")))
          ? cloudRoot
          : AbsolutePath.make(path.join(cloudRoot, name))
      const gitDir = path.join(targetDir, ".git")

      if (!(yield* fs.isDir(gitDir))) {
        const entries = (yield* fs.isDir(targetDir))
          ? yield* fs.readDirectoryEntries(targetDir).pipe(
              Effect.mapError(
                (cause) =>
                  new OperationError({
                    reason: "operation_failed",
                    detail: `failed to inspect ${targetDir}`,
                    cause,
                  }),
              ),
            )
          : []
        if (entries.length > 0) {
          return yield* new OperationError({
            reason: "directory_conflict",
            detail: `cloud skill directory is not empty: ${targetDir}`,
          })
        }
        yield* fs.ensureDir(path.dirname(targetDir)).pipe(
          Effect.mapError(
            (cause) =>
              new OperationError({
                reason: "operation_failed",
                detail: `failed to create ${path.dirname(targetDir)}`,
                cause,
              }),
          ),
        )
        yield* requireSuccess(
          yield* run(path.dirname(targetDir), ["clone", "--origin", "origin", "--", repository, targetDir], repository),
        )
        return yield* inspectRepo(targetDir, name)
      }

      const origin = yield* run(targetDir, ["remote", "get-url", "origin"])
      const command = origin.exitCode === 0 ? ["remote", "set-url", "origin", repository] : ["remote", "add", "origin", repository]
      yield* requireSuccess(yield* run(targetDir, command, repository))
      return yield* inspectRepo(targetDir, name)
    })

    const updateOne = Effect.fnUntraced(function* (repo: Status) {
      if (repo.changes > 0) {
        return yield* new OperationError({
          reason: "working_tree_dirty",
          detail: `sync or discard local cloud skill changes in "${repo.name}" before updating`,
        })
      }

      yield* requireSuccess(yield* run(repo.directory, ["fetch", "origin", "--prune"], repo.repository))
      const branch = repo.branch ?? (yield* defaultRemoteBranch(repo.directory))
      if (!branch) return yield* inspectRepo(repo.directory, repo.name)
      if (!(yield* remoteBranchExists(repo.directory, branch))) return yield* inspectRepo(repo.directory, repo.name)

      if (!repo.branch) {
        yield* requireSuccess(
          yield* run(repo.directory, ["checkout", "-B", branch, `origin/${branch}`]),
          "merge_conflict",
        )
        return yield* inspectRepo(repo.directory, repo.name)
      }

      yield* requireSuccess(
        yield* run(repo.directory, ["merge", "--ff-only", `origin/${branch}`]),
        "merge_conflict",
      )
      return yield* inspectRepo(repo.directory, repo.name)
    })

    const updateUnsafe = Effect.fnUntraced(function* (input?: UpdateInput) {
      const all = yield* listRepos()
      if (input?.name) {
        const target = all.find((r) => r.name === input.name)
        if (!target) {
          return yield* new OperationError({
            reason: "not_found",
            detail: `cloud skill repository "${input.name}" not found`,
          })
        }
        const updated = yield* updateOne(target)
        return [updated]
      }

      if (all.length === 0) {
        return yield* new OperationError({
          reason: "not_configured",
          detail: "no cloud skill repositories configured",
        })
      }

      const results: Status[] = []
      for (const repo of all) {
        results.push(yield* updateOne(repo))
      }
      return results
    })

    const syncUnsafe = Effect.fnUntraced(function* (input?: SyncInput) {
      const all = yield* listRepos()
      const target = input?.name ? all.find((r) => r.name === input.name) : all[0]
      if (!target) {
        return yield* new OperationError({
          reason: input?.name ? "not_found" : "not_configured",
          detail: input?.name
            ? `cloud skill repository "${input.name}" not found`
            : "configure a Git repository before syncing cloud skills",
        })
      }

      yield* requireSuccess(yield* run(target.directory, ["add", "--all", "--", "."]))

      const staged = yield* run(target.directory, ["diff", "--cached", "--quiet", "--", "."])
      if (staged.exitCode !== 0 && staged.exitCode !== 1) yield* requireSuccess(staged)
      if (staged.exitCode === 1) {
        const message = input?.message?.trim() || `chore(skills): sync cloud skills (${target.name})`
        yield* requireSuccess(
          yield* run(target.directory, [
            "-c",
            "user.name=OpenCode",
            "-c",
            "user.email=opencode@localhost",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=",
            "commit",
            "-m",
            message,
          ]),
        )
      }

      const committed = yield* inspectRepo(target.directory, target.name)
      if (!committed.head) return committed
      const branch = committed.branch
      if (!branch) {
        return yield* new OperationError({
          reason: "merge_conflict",
          detail: `cloud skill repository "${target.name}" is in a detached HEAD state`,
        })
      }

      yield* requireSuccess(yield* run(target.directory, ["fetch", "origin", "--prune"], target.repository))
      if (yield* remoteBranchExists(target.directory, branch)) {
        const rebased = yield* run(target.directory, ["rebase", `origin/${branch}`])
        if (rebased.exitCode !== 0) {
          yield* run(target.directory, ["rebase", "--abort"]).pipe(Effect.ignore)
          yield* requireSuccess(rebased, "merge_conflict")
        }
      }
      yield* requireSuccess(
        yield* run(target.directory, ["push", "--set-upstream", "origin", `HEAD:refs/heads/${branch}`], target.repository),
      )
      return yield* inspectRepo(target.directory, target.name)
    })

    const removeUnsafe = Effect.fnUntraced(function* (input: RemoveInput) {
      const all = yield* listRepos()
      const target = all.find((r) => r.name === input.name)
      if (!target) {
        return yield* new OperationError({
          reason: "not_found",
          detail: `cloud skill repository "${input.name}" not found`,
        })
      }

      if (target.changes > 0) {
        return yield* new OperationError({
          reason: "working_tree_dirty",
          detail: `repository "${target.name}" has uncommitted local changes; sync or discard them before deleting`,
        })
      }

      yield* fs.remove(target.directory, { recursive: true, force: true }).pipe(
        Effect.mapError(
          (cause) =>
            new OperationError({
              reason: "operation_failed",
              detail: `failed to remove repository directory ${target.directory}`,
              cause,
            }),
        ),
      )

      return yield* listRepos()
    })

    return Service.of({
      list: Effect.fn("SkillCloud.list")(function* () {
        return yield* locked(listRepos())
      }),
      status: Effect.fn("SkillCloud.status")(function* (name?: string) {
        return yield* locked(statusUnsafe(name))
      }),
      configure: Effect.fn("SkillCloud.configure")(function* (input) {
        return yield* locked(configureUnsafe(input))
      }),
      update: Effect.fn("SkillCloud.update")(function* (input?: UpdateInput) {
        return yield* locked(updateUnsafe(input))
      }),
      sync: Effect.fn("SkillCloud.sync")(function* (input?: SyncInput) {
        return yield* locked(syncUnsafe(input))
      }),
      remove: Effect.fn("SkillCloud.remove")(function* (input: RemoveInput) {
        return yield* locked(removeUnsafe(input))
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [AppProcess.node, DeployKey.node, EffectFlock.node, FSUtil.node, Global.node],
})
