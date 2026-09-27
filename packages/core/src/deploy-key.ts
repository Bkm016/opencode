export * as DeployKey from "./deploy-key"

import { DeployKey } from "@opencode-ai/schema/deploy-key"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import path from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "./process"
import { makeGlobalNode } from "./effect/app-node"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { Repository } from "./repository"
import { EffectFlock } from "./util/effect-flock"
import { which } from "./util/which"

const filename = "id_ed25519"

export class OperationError extends Schema.TaggedErrorClass<OperationError>()("DeployKeyOperationError", {
  reason: DeployKey.ErrorReason,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return `Deploy key unavailable: ${this.detail}`
  }
}

export interface Interface {
  /**
   * Returns the deploy key dedicated to one remote repository, generating it when needed.
   * Different spellings of the same remote (SSH, HTTPS, shorthand) resolve to the same key.
   */
  readonly get: (repository: string) => Effect.Effect<DeployKey.Info, OperationError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/DeployKey") {}

function normalizePublicKey(value: string, comment: string) {
  const [algorithm, encoded] = value.trim().split(/\s+/)
  if (algorithm !== "ssh-ed25519" || !encoded) return
  return `${algorithm} ${encoded} ${comment}`
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const appProcess = yield* AppProcess.Service
    const flock = yield* EffectFlock.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    // 旧版全局共享的 ssh/opencode_deploy 已弃用，按仓库密钥放在独立子目录，避免与其混用。
    const root = path.join(global.data, "ssh", "deploy")
    const executable = yield* Effect.sync(() => which("ssh-keygen"))

    const run = Effect.fnUntraced(function* (args: string[]) {
      if (!executable) {
        return yield* new OperationError({ reason: "unavailable", detail: "ssh-keygen was not found on PATH" })
      }
      const result = yield* appProcess.run(ChildProcess.make(executable, args, { extendEnv: true, stdin: "ignore" }))
      if (result.exitCode === 0) return result.stdout.toString("utf8")
      return yield* new OperationError({
        reason: "unavailable",
        detail: result.stderr.toString("utf8").trim() || `ssh-keygen exited with code ${result.exitCode}`,
      })
    })

    const ensureUnsafe = Effect.fnUntraced(
      function* (reference: Repository.RemoteReference) {
        const repository = Repository.cacheIdentity(reference)
        const comment = `opencode-deploy@${repository}`
        const directory = Repository.cachePath(root, reference)
        const privateKeyPath = path.join(directory, filename)
        const publicKeyPath = `${privateKeyPath}.pub`
        const info = (publicKey: string): DeployKey.Info => ({
          repository,
          algorithm: "ssh-ed25519",
          publicKey,
          publicKeyPath: AbsolutePath.make(publicKeyPath),
          privateKeyPath: AbsolutePath.make(privateKeyPath),
        })

        yield* fs.ensureDir(directory)
        if (process.platform !== "win32") yield* fs.chmod(directory, 0o700)

        const [privateExists, publicExists] = yield* Effect.all([fs.exists(privateKeyPath), fs.exists(publicKeyPath)])
        if (privateExists && !(yield* fs.isFile(privateKeyPath))) {
          return yield* new OperationError({ reason: "unavailable", detail: `${privateKeyPath} is not a file` })
        }
        if (publicExists && !(yield* fs.isFile(publicKeyPath))) {
          return yield* new OperationError({ reason: "unavailable", detail: `${publicKeyPath} is not a file` })
        }

        if (privateExists) {
          const publicKey = normalizePublicKey(yield* run(["-y", "-f", privateKeyPath]), comment)
          if (!publicKey) {
            return yield* new OperationError({
              reason: "unavailable",
              detail: "ssh-keygen returned an invalid public key",
            })
          }

          const stored = publicExists ? normalizePublicKey(yield* fs.readFileString(publicKeyPath), comment) : undefined
          if (stored !== publicKey) {
            yield* fs.writeFileString(publicKeyPath, publicKey + "\n", { mode: 0o644 })
          }
          if (process.platform !== "win32") yield* fs.chmod(privateKeyPath, 0o600)
          return info(publicKey)
        }

        // 仅剩公钥时已无法完成认证；先生成新私钥，成功后再替换旧公钥。
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const temporary = yield* fs.makeTempDirectoryScoped({ directory, prefix: ".deploy-key-" })
            const temporaryPrivate = path.join(temporary, filename)
            const temporaryPublic = `${temporaryPrivate}.pub`
            yield* run(["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", temporaryPrivate])

            const publicKey = normalizePublicKey(yield* fs.readFileString(temporaryPublic), comment)
            if (!publicKey) {
              return yield* new OperationError({
                reason: "unavailable",
                detail: "ssh-keygen created an invalid public key",
              })
            }

            yield* fs.rename(temporaryPrivate, privateKeyPath)
            if (publicExists) yield* fs.remove(publicKeyPath, { force: true })
            yield* fs.rename(temporaryPublic, publicKeyPath)
            if (process.platform !== "win32") {
              yield* fs.chmod(privateKeyPath, 0o600)
              yield* fs.chmod(publicKeyPath, 0o644)
            }
            return info(publicKey)
          }),
        )
      },
      Effect.mapError((cause) =>
        cause instanceof OperationError
          ? cause
          : new OperationError({ reason: "unavailable", detail: "failed to prepare the managed key files", cause }),
      ),
    )

    const cache = new Map<string, DeployKey.Info>()
    const get = Effect.fn("DeployKey.get")(function* (repository: string) {
      const reference = Repository.parse(repository)
      if (!reference || !Repository.isRemote(reference)) {
        return yield* new OperationError({
          reason: "invalid_repository",
          detail: "repository must be a remote Git URL, host/path reference, or GitHub owner/repo shorthand",
        })
      }
      const identity = Repository.cacheIdentity(reference)
      const cached = cache.get(identity)
      if (cached) return cached
      const info = yield* ensureUnsafe(reference).pipe(
        flock.withLock(`deploy-key:${identity}`),
        Effect.mapError((cause) =>
          cause instanceof OperationError
            ? cause
            : new OperationError({ reason: "unavailable", detail: "failed to acquire the deploy key lock", cause }),
        ),
      )
      cache.set(identity, info)
      return info
    })

    return Service.of({ get })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [AppProcess.node, EffectFlock.node, FSUtil.node, Global.node],
})
