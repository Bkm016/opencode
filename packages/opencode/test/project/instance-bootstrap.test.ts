import { afterEach, expect } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Cause, Deferred, Effect, Exit, Fiber, Option } from "effect"
import { bootstrap as cliBootstrap } from "../../src/cli/bootstrap"
import {
  acquireInstanceActivity,
  beginInstanceReload,
  registerDisposer,
} from "../../src/effect/instance-registry"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { waitGlobalBusEvent } from "../server/global-bus"

const it = testEffect(
  LayerNode.compile(LayerNode.group([InstanceStore.node, CrossSpawnSpawner.node]), [
    [InstanceStore.bootstrapNode, InstanceBootstrap.node],
  ]),
)

// InstanceBootstrap must run before any code touches the instance —
// originally tracked by PRs #25389 and #25449, now a permanent
// invariant. The plugin config hook writes a marker file; the test
// bodies deliberately avoid Plugin/config directly. The marker only
// appears if InstanceBootstrap ran at the instance boundary.
//
// The boundaries below are transport-agnostic and stay.

afterEach(async () => {
  await disposeAllInstances()
})

const bootstrapFixture = Effect.gen(function* () {
  const dir = yield* tmpdirScoped({ git: true })
  const marker = path.join(dir, "config-hook-fired")
  const pluginFile = path.join(dir, "plugin.ts")
  yield* Effect.promise(() =>
    Bun.write(
      pluginFile,
      [
        `const MARKER = ${JSON.stringify(marker)}`,
        "export default async () => ({",
        "  config: async () => {",
        '    await Bun.write(MARKER, "ran")',
        "  },",
        "})",
        "",
      ].join("\n"),
    ),
  )
  yield* Effect.promise(() =>
    Bun.write(
      path.join(dir, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        plugin: [pathToFileURL(pluginFile).href],
      }),
    ),
  )
  return { directory: dir, marker }
})

function waitDisposed(directory: string) {
  return waitGlobalBusEvent({
    message: "timed out waiting for CLI bootstrap instance disposal",
    predicate: (event) => event.payload.type === "server.instance.disposed" && event.directory === directory,
  })
}

it.live("InstanceStore.provide runs InstanceBootstrap before effect", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrapFixture
    const store = yield* InstanceStore.Service

    yield* store.provide({ directory: tmp.directory }, Effect.succeed("ok"))

    expect(existsSync(tmp.marker)).toBe(true)
  }),
)

it.live("CLI bootstrap runs InstanceBootstrap before callback", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrapFixture

    yield* Effect.promise(() => cliBootstrap(tmp.directory, async () => "ok"))

    expect(existsSync(tmp.marker)).toBe(true)
  }),
)

it.live("CLI bootstrap disposes the instance when the callback rejects", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrapFixture
    const disposed = yield* waitDisposed(tmp.directory).pipe(Effect.forkScoped({ startImmediately: true }))

    const exit = yield* Effect.promise(() =>
      cliBootstrap(tmp.directory, async () => Promise.reject(new Error("boom"))),
    ).pipe(Effect.exit)

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ message: "boom" })
    yield* Fiber.join(disposed)
  }),
)

it.live("InstanceStore.reload runs InstanceBootstrap", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrapFixture
    const store = yield* InstanceStore.Service

    yield* store.reload({ directory: tmp.directory })

    expect(existsSync(tmp.marker)).toBe(true)
  }),
)

it.live("InstanceStore.reload waits for active instance work", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrapFixture
    const store = yield* InstanceStore.Service
    const reloading = yield* Deferred.make<void>()
    const releaseReload = yield* Deferred.make<() => void>()
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        registerDisposer((directory) => {
          if (directory !== tmp.directory) return Promise.resolve()
          Deferred.doneUnsafe(reloading, Effect.void)
          return new Promise<void>((resolve) => Deferred.doneUnsafe(releaseReload, Effect.succeed(resolve)))
        }),
      ),
      (off) => Effect.sync(off),
    )
    yield* store.load({ directory: tmp.directory })
    const activity = yield* Effect.promise((signal) => acquireInstanceActivity(tmp.directory, signal))
    yield* Effect.addFinalizer(() => Effect.sync(activity.release))

    const reload = yield* store.reload({ directory: tmp.directory }).pipe(Effect.forkScoped({ startImmediately: true }))
    const blocked = yield* Fiber.join(reload).pipe(Effect.timeoutOption("20 millis"))
    expect(Option.isNone(blocked)).toBe(true)

    const admittedWhileDraining = yield* Effect.promise((signal) => acquireInstanceActivity(tmp.directory, signal))
    admittedWhileDraining.release()

    activity.release()
    yield* Deferred.await(reloading).pipe(Effect.timeout("2 seconds"))

    const queued = yield* Effect.promise((signal) => acquireInstanceActivity(tmp.directory, signal)).pipe(
      Effect.forkScoped({ startImmediately: true }),
    )
    const acquiredDuringReload = yield* Fiber.join(queued).pipe(Effect.timeoutOption("20 millis"))
    expect(Option.isNone(acquiredDuringReload)).toBe(true)

    const finishReload = yield* Deferred.await(releaseReload).pipe(Effect.timeout("2 seconds"))
    yield* Effect.sync(finishReload)
    yield* Fiber.join(reload).pipe(Effect.timeout("2 seconds"))
    const nextActivity = yield* Fiber.join(queued).pipe(Effect.timeout("2 seconds"))
    nextActivity.release()
  }),
  20_000,
)

it.live("aborted reload drain reopens instance admission", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const activity = yield* Effect.promise((signal) => acquireInstanceActivity(directory, signal))
    yield* Effect.addFinalizer(() => Effect.sync(activity.release))
    const controller = new AbortController()

    const reload = beginInstanceReload(directory, controller.signal)
    controller.abort()
    activity.release()
    const exit = yield* Effect.promise(() => reload).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)

    const next = yield* Effect.promise((signal) => acquireInstanceActivity(directory, signal)).pipe(
      Effect.timeout("2 seconds"),
    )
    next.release()
  }),
)
