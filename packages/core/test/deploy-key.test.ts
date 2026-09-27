import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DeployKey } from "@opencode-ai/core/deploy-key"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

function layer(root: string) {
  return Layer.fresh(
    AppNodeBuilder.build(DeployKey.node, [
      [
        Global.node,
        Global.layerWith({
          home: root,
          data: path.join(root, "data"),
          cache: path.join(root, "cache"),
          config: path.join(root, "config"),
          state: path.join(root, "state"),
          tmp: path.join(root, "tmp"),
          bin: path.join(root, "bin"),
          log: path.join(root, "log"),
          repos: path.join(root, "repos"),
        }),
      ],
    ]),
  )
}

function load(root: string, repository: string) {
  return DeployKey.Service.use((deployKey) => deployKey.get(repository)).pipe(
    Effect.provide(layer(root)),
    Effect.scoped,
    Effect.runPromise,
  )
}

describe("DeployKey", () => {
  test("generates one reusable OpenSSH Ed25519 key pair per remote repository", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-deploy-key-"))
    roots.push(root)

    const first = await load(root, "git@github.com:acme/skills.git")
    const privateKey = await fs.readFile(first.privateKeyPath, "utf8")
    const publicKey = await fs.readFile(first.publicKeyPath, "utf8")

    expect(first.repository).toBe("github.com/acme/skills")
    expect(first.algorithm).toBe("ssh-ed25519")
    expect(first.publicKey).toStartWith("ssh-ed25519 ")
    expect(privateKey).toStartWith("-----BEGIN OPENSSH PRIVATE KEY-----")
    expect(publicKey.trim()).toBe(first.publicKey)

    const derived = Bun.spawnSync(["ssh-keygen", "-y", "-f", first.privateKeyPath])
    expect(derived.exitCode).toBe(0)
    expect(derived.stdout.toString().trim().split(/\s+/).slice(0, 2)).toEqual(first.publicKey.split(/\s+/).slice(0, 2))

    // 同一远端的不同写法共用一把密钥，且缺失公钥时从私钥恢复而不是重新生成。
    await fs.rm(first.publicKeyPath)
    const same = await load(root, "https://github.com/acme/skills")
    expect(same).toEqual(first)
    expect(await fs.readFile(same.privateKeyPath, "utf8")).toBe(privateKey)
    expect((await fs.readFile(same.publicKeyPath, "utf8")).trim()).toBe(first.publicKey)

    // GitHub 部署公钥全局唯一，其他仓库必须拿到不同的密钥。
    const other = await load(root, "git@github.com:acme/other.git")
    expect(other.repository).toBe("github.com/acme/other")
    expect(other.privateKeyPath).not.toBe(first.privateKeyPath)
    expect(other.publicKey.split(/\s+/)[1]).not.toBe(first.publicKey.split(/\s+/)[1])

    if (process.platform !== "win32") {
      expect((await fs.stat(path.dirname(first.privateKeyPath))).mode & 0o777).toBe(0o700)
      expect((await fs.stat(first.privateKeyPath)).mode & 0o777).toBe(0o600)
      expect((await fs.stat(first.publicKeyPath)).mode & 0o777).toBe(0o644)
    }
  })

  test("rejects repositories that are not remote", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-deploy-key-"))
    roots.push(root)

    const error = await DeployKey.Service.use((deployKey) => Effect.flip(deployKey.get("not a repository"))).pipe(
      Effect.provide(layer(root)),
      Effect.scoped,
      Effect.runPromise,
    )
    expect(error.reason).toBe("invalid_repository")
  })
})
