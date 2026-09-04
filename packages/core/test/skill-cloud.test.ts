import { afterEach, describe, expect, test } from "bun:test"
import { SkillCloud } from "@opencode-ai/core/skill-cloud"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { Effect, Layer } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { git, gitRemote } from "./fixture/git"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

function layer(root: string) {
  return Layer.fresh(
    AppNodeBuilder.build(SkillCloud.node, [
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

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-skill-cloud-"))
  roots.push(root)
  const remote = await gitRemote(root)
  const file = path.join(remote.source, "review-code", "SKILL.md")
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, "---\nname: review-code\ndescription: Review code\n---\n\nVersion one.\n")
  await git(remote.source, "add", ".")
  await git(remote.source, "commit", "-m", "add skill")
  await git(remote.source, "push")
  return { root, remote, file }
}

function run<A, E>(root: string, effect: Effect.Effect<A, E, SkillCloud.Service>) {
  return effect.pipe(Effect.provide(layer(root)), Effect.scoped, Effect.runPromise)
}

describe("SkillCloud", () => {
  test("updates and syncs the managed cloud skill checkout", async () => {
    const input = await fixture()
    const result = await run(
      input.root,
      Effect.gen(function* () {
        const cloud = yield* SkillCloud.Service
        const initial = yield* cloud.status()
        const configured = yield* cloud.configure({ repository: input.remote.remote, name: "team" })
        yield* Effect.promise(async () => {
          await fs.writeFile(input.file, "---\nname: review-code\ndescription: Review code\n---\n\nVersion two.\n")
          await git(input.remote.source, "add", ".")
          await git(input.remote.source, "commit", "-m", "update skill")
          await git(input.remote.source, "push")
        })
        const updatedList = yield* cloud.update({ name: "team" })
        const updated = updatedList[0]
        const content = yield* Effect.promise(() => fs.readFile(path.join(updated.directory, "review-code", "SKILL.md"), "utf8"))
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(updated.directory, "review-code", "SKILL.md"),
            "---\nname: review-code\ndescription: Review code\n---\n\nVersion three.\n",
          ),
        )
        const modified = yield* cloud.status("team")
        const synced = yield* cloud.sync({ name: "team", message: "feat(skills): update review guidance" })
        return { initial, configured, content, modified, synced }
      }),
    )

    expect(result.initial.state).toBe("unconfigured")
    expect(result.configured.state).toBe("ready")
    expect(result.configured.name).toBe("team")
    expect(String(result.configured.directory)).toBe(path.join(input.root, "config", "skills", "cloud", "team"))
    expect(result.content).toContain("Version two.")
    expect(result.modified.state).toBe("modified")
    expect(result.synced.state).toBe("ready")

    await git(input.remote.source, "pull", "--ff-only")
    expect(await fs.readFile(input.file, "utf8")).toContain("Version three.")
  }, 30_000)

  test("manages multiple cloud skill repositories", async () => {
    const input = await fixture()
    const result = await run(
      input.root,
      Effect.gen(function* () {
        const cloud = yield* SkillCloud.Service
        yield* cloud.configure({ repository: input.remote.remote, name: "repo-a" })
        yield* cloud.configure({ repository: input.remote.remote, name: "repo-b" })
        const list = yield* cloud.list()
        const removed = yield* cloud.remove({ name: "repo-a" })
        return { list, removed }
      }),
    )

    expect(result.list.length).toBe(2)
    expect(result.list.map((r) => r.name)).toEqual(["repo-a", "repo-b"])
    expect(result.removed.length).toBe(1)
    expect(result.removed[0].name).toBe("repo-b")
  }, 30_000)

  test("refuses to update over local cloud skill changes", async () => {
    const input = await fixture()
    const error = await run(
      input.root,
      Effect.gen(function* () {
        const cloud = yield* SkillCloud.Service
        const configured = yield* cloud.configure({ repository: input.remote.remote, name: "main" })
        yield* Effect.promise(() =>
          fs.writeFile(path.join(configured.directory, "review-code", "SKILL.md"), "local change\n"),
        )
        return yield* Effect.flip(cloud.update({ name: "main" }))
      }),
    )

    expect(error.reason).toBe("working_tree_dirty")
    expect(await fs.readFile(path.join(input.root, "config", "skills", "cloud", "main", "review-code", "SKILL.md"), "utf8")).toBe(
      "local change\n",
    )
  }, 30_000)
})
