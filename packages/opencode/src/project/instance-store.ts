import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { makeGlobalNode, Node } from "@opencode-ai/core/effect/app-node"
import { GlobalBus } from "@/bus/global"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { InstanceRef } from "@/effect/instance-ref"
import { disposeInstance as runDisposers } from "@/effect/instance-registry"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import { ConfigHotReload, isConfigHotReloadPath } from "@/config/hot-reload"
import { Context, Deferred, Duration, Effect, Exit, Layer, Scope } from "effect"
import { existsSync, statSync, watch, type FSWatcher } from "node:fs"
import path from "node:path"
import { type InstanceContext } from "./instance-context"
import { InstanceBootstrap } from "./bootstrap-service"
import * as Project from "./project"

export interface LoadInput {
  directory: string
  worktree?: string
  project?: Project.Info
}

export interface Interface {
  readonly load: (input: LoadInput) => Effect.Effect<InstanceContext>
  readonly reload: (input: LoadInput) => Effect.Effect<InstanceContext>
  readonly dispose: (ctx: InstanceContext) => Effect.Effect<void>
  readonly disposeDirectory: (directory: string) => Effect.Effect<void>
  readonly disposeAll: () => Effect.Effect<void>
  readonly provide: <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/InstanceStore") {}

export const use = serviceUse(Service)

interface Entry {
  readonly deferred: Deferred.Deferred<InstanceContext>
}

interface HotReloadWatch {
  readonly watchers: FSWatcher[]
  timer: ReturnType<typeof setTimeout> | undefined
  paused: boolean
  // Windows recursive watch often emits a burst when the watcher is first attached.
  ignoreUntil: number
}

function collectWatchRoots(ctx: InstanceContext) {
  const roots = new Set<string>()
  // Prefer specific files under the global config dir; fall back to the dir only
  // when no known config file exists yet (first-run create still needs a watch).
  const globalFiles = ["opencode.json", "opencode.jsonc", "config.json"].map((name) =>
    path.join(Global.Path.config, name),
  )
  const hitGlobal = globalFiles.filter((file) => existsSync(file))
  if (hitGlobal.length > 0) for (const file of hitGlobal) roots.add(file)
  else if (existsSync(Global.Path.config)) roots.add(Global.Path.config)

  for (const dir of [ctx.directory, ctx.worktree]) {
    for (const name of ["opencode.json", "opencode.jsonc"]) {
      const file = path.join(dir, name)
      if (existsSync(file)) roots.add(file)
    }
    // Project config package (skills/plugins/agents/commands live under here).
    roots.add(path.join(dir, ".opencode"))
    roots.add(path.join(dir, ".claude", "skills"))
    roots.add(path.join(dir, ".agents", "skills"))
  }
  if (Flag.OPENCODE_CONFIG) {
    const file = Flag.OPENCODE_CONFIG
    roots.add(existsSync(file) ? file : path.dirname(file))
  }
  if (Flag.OPENCODE_CONFIG_DIR) roots.add(Flag.OPENCODE_CONFIG_DIR)
  // Home skill trees only (not all of ~/.claude) so recursive watch stays cheap.
  roots.add(path.join(Global.Path.home, ".claude", "skills"))
  roots.add(path.join(Global.Path.home, ".agents", "skills"))
  // Global skills/plugins under ~/.config/opencode.
  roots.add(path.join(Global.Path.config, "skill"))
  roots.add(path.join(Global.Path.config, "skills"))
  roots.add(path.join(Global.Path.config, "plugin"))
  roots.add(path.join(Global.Path.config, "plugins"))
  roots.add(path.join(Global.Path.config, "agent"))
  roots.add(path.join(Global.Path.config, "agents"))
  roots.add(path.join(Global.Path.config, "command"))
  roots.add(path.join(Global.Path.config, "commands"))
  return [...roots].filter((root) => existsSync(root))
}

function isDirectory(root: string) {
  try {
    return statSync(root).isDirectory()
  } catch {
    return false
  }
}

const layer: Layer.Layer<Service, never, Project.Service | InstanceBootstrap.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const project = yield* Project.Service
    const bootstrap = yield* InstanceBootstrap.Service
    const scope = yield* Scope.Scope
    const cache = new Map<string, Entry>()
    const hotReload = new Map<string, HotReloadWatch>()

    const stopHotReload = (directory: string) => {
      const state = hotReload.get(directory)
      if (!state) return
      hotReload.delete(directory)
      if (state.timer) clearTimeout(state.timer)
      for (const watcher of state.watchers) watcher.close()
    }

    const pauseHotReload = (directory: string) => {
      const state = hotReload.get(directory)
      if (!state) return
      state.paused = true
      if (state.timer) {
        clearTimeout(state.timer)
        state.timer = undefined
      }
    }

    let doReload: (input: LoadInput) => Effect.Effect<InstanceContext> = () =>
      Effect.die(new Error("InstanceStore.reload not ready"))

    const scheduleHotReload = (directory: string, reason: string) => {
      const state = hotReload.get(directory)
      if (!state || state.paused) return
      if (state.timer) clearTimeout(state.timer)
      state.timer = setTimeout(() => {
        state.timer = undefined
        if (state.paused) return
        if (cache.get(directory) === undefined) return
        Effect.runFork(
          Effect.gen(function* () {
            yield* Effect.logInfo("config hot reload", { directory, reason })
            // Drop global config cache so the re-bootstrapped instance re-reads disk.
            yield* Effect.promise(async () => {
              const { AppRuntime } = await import("@/effect/app-runtime")
              const { Config } = await import("@/config/config")
              await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.invalidate()))
            }).pipe(Effect.ignore)
            yield* doReload({ directory })
          }).pipe(Effect.catchCause((cause) => Effect.logWarning("config hot reload failed", { directory, cause }))),
        )
      }, ConfigHotReload.DEBOUNCE_MS)
    }

    const startHotReload = (ctx: InstanceContext) => {
      // Tests pin OPENCODE_TEST_HOME; skip watchers so fixture churn does not
      // compete with short timeouts or re-enter reload mid-assertion.
      if (process.env.OPENCODE_TEST_HOME) return
      if (Flag.OPENCODE_DISABLE_CONFIG_HOT_RELOAD) return
      stopHotReload(ctx.directory)
      const state: HotReloadWatch = {
        watchers: [],
        timer: undefined,
        paused: false,
        ignoreUntil: Date.now() + 4000,
      }
      for (const root of collectWatchRoots(ctx)) {
        try {
          const watcher = watch(root, { recursive: isDirectory(root) }, (_event, filename) => {
            if (Date.now() < state.ignoreUntil) return
            const file = filename ? path.join(root, filename.toString()) : root
            if (!isConfigHotReloadPath(file)) return
            scheduleHotReload(ctx.directory, file)
          })
          watcher.on("error", () => {})
          state.watchers.push(watcher)
        } catch {
          // Unwatchable roots (permissions / network drives) are skipped.
        }
      }
      if (state.watchers.length === 0) return
      hotReload.set(ctx.directory, state)
    }

    const boot = (input: LoadInput & { directory: string }) =>
      Effect.gen(function* () {
        const ctx: InstanceContext =
          input.project && input.worktree
            ? {
                directory: input.directory,
                worktree: input.worktree,
                project: input.project,
              }
            : yield* project.fromDirectory(input.directory).pipe(
                Effect.map((result) => ({
                  directory: input.directory,
                  worktree: result.sandbox,
                  project: result.project,
                })),
              )
        yield* bootstrap.run.pipe(Effect.provideService(InstanceRef, ctx))
        return ctx
      }).pipe(Effect.withSpan("InstanceStore.boot"))

    const removeEntry = (directory: string, entry: Entry) =>
      Effect.sync(() => {
        if (cache.get(directory) !== entry) return false
        cache.delete(directory)
        stopHotReload(directory)
        return true
      })

    const completeLoad = (directory: string, input: LoadInput, entry: Entry) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(boot({ ...input, directory }))
        if (Exit.isFailure(exit)) {
          yield* removeEntry(directory, entry)
        } else {
          // Attach watchers only after a successful boot so config-time writes cannot self-trigger.
          startHotReload(exit.value)
        }
        yield* Deferred.done(entry.deferred, exit).pipe(Effect.asVoid)
      })

    const emitDisposed = (input: { directory: string; project?: string }) =>
      Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: input.directory,
          project: input.project,
          workspace: WorkspaceContext.workspaceID,
          payload: {
            type: "server.instance.disposed",
            properties: {
              directory: input.directory,
            },
          },
        }),
      )

    const disposeContext = Effect.fn("InstanceStore.disposeContext")(function* (ctx: InstanceContext) {
      yield* Effect.logInfo("disposing instance", { directory: ctx.directory })
      stopHotReload(ctx.directory)
      yield* Effect.promise(() => runDisposers(ctx.directory))
      yield* emitDisposed({ directory: ctx.directory, project: ctx.project.id })
    })

    const disposeEntry = Effect.fnUntraced(function* (directory: string, entry: Entry, ctx: InstanceContext) {
      if (cache.get(directory) !== entry) return false
      yield* disposeContext(ctx)
      if (cache.get(directory) !== entry) return false
      cache.delete(directory)
      return true
    })

    const load = (input: LoadInput): Effect.Effect<InstanceContext> => {
      const directory = FSUtil.resolve(input.directory)
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const existing = cache.get(directory)
          if (existing) return yield* restore(Deferred.await(existing.deferred))

          const entry: Entry = { deferred: Deferred.makeUnsafe<InstanceContext>() }
          cache.set(directory, entry)
          yield* Effect.gen(function* () {
            yield* Effect.logInfo("creating instance", { directory: directory })
            yield* completeLoad(directory, input, entry)
          }).pipe(Effect.forkIn(scope, { startImmediately: true }))
          return yield* restore(Deferred.await(entry.deferred))
        }),
      ).pipe(Effect.withSpan("InstanceStore.load"))
    }

    const reload = (input: LoadInput): Effect.Effect<InstanceContext> => {
      const directory = FSUtil.resolve(input.directory)
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const previous = cache.get(directory)
          const entry: Entry = { deferred: Deferred.makeUnsafe<InstanceContext>() }
          cache.set(directory, entry)
          yield* Effect.gen(function* () {
            yield* Effect.logInfo("reloading instance", { directory: directory })
            if (previous) {
              yield* Deferred.await(previous.deferred).pipe(Effect.ignore)
              pauseHotReload(directory)
              stopHotReload(directory)
              yield* Effect.promise(() => runDisposers(directory))
              yield* emitDisposed({ directory, project: input.project?.id })
            }
            yield* completeLoad(directory, input, entry)
          }).pipe(Effect.forkIn(scope, { startImmediately: true }))
          return yield* restore(Deferred.await(entry.deferred))
        }),
      ).pipe(Effect.withSpan("InstanceStore.reload"))
    }
    doReload = reload

    const dispose = Effect.fn("InstanceStore.dispose")(function* (ctx: InstanceContext) {
      const entry = cache.get(ctx.directory)
      if (!entry) return yield* disposeContext(ctx)

      const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
      if (Exit.isFailure(exit)) return yield* removeEntry(ctx.directory, entry).pipe(Effect.asVoid)
      if (exit.value !== ctx) return
      yield* disposeEntry(ctx.directory, entry, ctx).pipe(Effect.asVoid)
    })

    const disposeDirectory = Effect.fn("InstanceStore.disposeDirectory")(function* (input: string) {
      const directory = FSUtil.resolve(input)
      const entry = cache.get(directory)
      if (!entry) return
      const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
      if (Exit.isFailure(exit)) return yield* removeEntry(directory, entry).pipe(Effect.asVoid)
      yield* disposeEntry(directory, entry, exit.value).pipe(Effect.asVoid)
    })

    const disposeAllOnce = Effect.fnUntraced(function* () {
      yield* Effect.logInfo("disposing all instances")
      yield* Effect.forEach(
        [...cache.entries()],
        (item) =>
          Effect.gen(function* () {
            const exit = yield* Deferred.await(item[1].deferred).pipe(Effect.exit)
            if (Exit.isFailure(exit)) {
              yield* Effect.logWarning("instance dispose failed", { key: item[0], cause: exit.cause })
              yield* removeEntry(item[0], item[1])
              return
            }
            yield* disposeEntry(item[0], item[1], exit.value)
          }),
        { discard: true },
      )
    })

    const cachedDisposeAll = yield* Effect.cachedWithTTL(disposeAllOnce(), Duration.zero)
    const disposeAll = Effect.fn("InstanceStore.disposeAll")(function* () {
      return yield* cachedDisposeAll
    })

    const provide = <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      load(input).pipe(Effect.flatMap((ctx) => effect.pipe(Effect.provideService(InstanceRef, ctx))))

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const directory of [...hotReload.keys()]) stopHotReload(directory)
      }).pipe(Effect.andThen(disposeAll().pipe(Effect.ignore))),
    )

    return Service.of({
      load,
      reload,
      dispose,
      disposeDirectory,
      disposeAll,
      provide,
    })
  }),
)

export const bootstrapNode = LayerNode.unbound(InstanceBootstrap.Service, Node.tags.values.global)

export const node = makeGlobalNode({
  service: Service,
  layer: layer,
  deps: [Project.node, bootstrapNode],
})

export * as InstanceStore from "./instance-store"
