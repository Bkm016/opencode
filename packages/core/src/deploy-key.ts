export * as DeployKey from "./deploy-key"

import type { DeployKey } from "@opencode-ai/schema/deploy-key"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import path from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "./process"
import { makeGlobalNode } from "./effect/app-node"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { EffectFlock } from "./util/effect-flock"
import { which } from "./util/which"

const comment = "opencode-deploy"
const filename = "opencode_deploy"

export class UnavailableError extends Schema.TaggedErrorClass<UnavailableError>()("DeployKeyUnavailableError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return `Deploy key unavailable: ${this.detail}`
  }
}

export interface Interface {
  /** Returns the server-wide deploy key, generating it when needed. */
  readonly get: () => Effect.Effect<DeployKey.Info, UnavailableError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/DeployKey") {}

function normalizePublicKey(value: string) {
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
    const directory = path.join(global.data, "ssh")
    const privateKeyPath = path.join(directory, filename)
    const publicKeyPath = `${privateKeyPath}.pub`

    const info = (publicKey: string): DeployKey.Info => ({
      algorithm: "ssh-ed25519",
      publicKey,
      publicKeyPath: AbsolutePath.make(publicKeyPath),
      privateKeyPath: AbsolutePath.make(privateKeyPath),
    })

    const executable = yield* Effect.sync(() => which("ssh-keygen"))

    const run = Effect.fnUntraced(function* (args: string[]) {
      if (!executable) {
        return yield* new UnavailableError({ detail: "ssh-keygen was not found on PATH" })
      }
      const result = yield* appProcess.run(ChildProcess.make(executable, args, { extendEnv: true, stdin: "ignore" }))
      if (result.exitCode === 0) return result.stdout.toString("utf8")
      return yield* new UnavailableError({
        detail: result.stderr.toString("utf8").trim() || `ssh-keygen exited with code ${result.exitCode}`,
      })
    })

    const ensureUnsafe = Effect.fnUntraced(
      function* () {
        yield* fs.ensureDir(directory)
        if (process.platform !== "win32") yield* fs.chmod(directory, 0o700)

        const [privateExists, publicExists] = yield* Effect.all([fs.exists(privateKeyPath), fs.exists(publicKeyPath)])
        if (privateExists && !(yield* fs.isFile(privateKeyPath))) {
          return yield* new UnavailableError({ detail: `${privateKeyPath} is not a file` })
        }
        if (publicExists && !(yield* fs.isFile(publicKeyPath))) {
          return yield* new UnavailableError({ detail: `${publicKeyPath} is not a file` })
        }

        if (privateExists) {
          const publicKey = normalizePublicKey(yield* run(["-y", "-f", privateKeyPath]))
          if (!publicKey) return yield* new UnavailableError({ detail: "ssh-keygen returned an invalid public key" })

          const stored = publicExists ? normalizePublicKey(yield* fs.readFileString(publicKeyPath)) : undefined
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

            const publicKey = normalizePublicKey(yield* fs.readFileString(temporaryPublic))
            if (!publicKey) {
              return yield* new UnavailableError({ detail: "ssh-keygen created an invalid public key" })
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
        cause instanceof UnavailableError
          ? cause
          : new UnavailableError({ detail: "failed to prepare the managed key files", cause }),
      ),
    )

    let cached: DeployKey.Info | undefined
    const get = Effect.fn("DeployKey.get")(function* () {
      if (cached) return cached
      cached = yield* ensureUnsafe().pipe(
        flock.withLock(`deploy-key:${privateKeyPath}`),
        Effect.mapError((cause) =>
          cause instanceof UnavailableError
            ? cause
            : new UnavailableError({ detail: "failed to acquire the deploy key lock", cause }),
        ),
      )
      return cached
    })

    // 密钥生成失败不应阻止 OpenCode 启动；设置页读取时会重试并返回明确错误。
    yield* get().pipe(
      Effect.catch((error) => Effect.logWarning("deploy key initialization failed", { message: error.message })),
    )

    return Service.of({ get })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [AppProcess.node, EffectFlock.node, FSUtil.node, Global.node],
})
