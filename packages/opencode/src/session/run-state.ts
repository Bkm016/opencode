import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Runner } from "@/effect/runner"
import { BackgroundJob } from "@/background/job"
import { Effect, Latch, Layer, Scope, Context } from "effect"
import { Session } from "./session"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"
import { acquireInstanceActivity, type InstanceActivity } from "@/effect/instance-registry"

export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  readonly promote: (sessionID: SessionID) => Effect.Effect<void>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
  ) => Effect.Effect<SessionV1.WithParts>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
    ready?: Latch.Latch,
  ) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunState") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const status = yield* SessionStatus.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* () {
        const scope = yield* Scope.Scope
        const runners = new Map<
          SessionID,
          {
            runner: Runner.Runner<SessionV1.WithParts>
            activate(activity: InstanceActivity): void
            releaseIfIdle(): void
          }
        >()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            yield* Effect.forEach(runners.values(), (entry) => entry.runner.cancel, {
              concurrency: "unbounded",
              discard: true,
            })
            runners.clear()
          }),
        )
        return { runners, scope }
      }),
    )

    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
    ) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing) return existing
      let activity: InstanceActivity | undefined
      const release = () => {
        activity?.release()
        activity = undefined
      }
      const next = Runner.make<SessionV1.WithParts>(data.scope, {
        onIdle: Effect.gen(function* () {
          data.runners.delete(sessionID)
          yield* status.set(sessionID, { type: "idle" })
        }).pipe(Effect.ensuring(Effect.sync(release))),
        onBusy: status.set(sessionID, { type: "busy" }),
        onInterrupt,
      })
      const entry = {
        runner: next,
        activate(nextActivity: InstanceActivity) {
          if (activity) return
          // Runner 脱离最初的请求 fiber 继续执行，因此必须独立持有租约直到真正 idle。
          nextActivity.retain()
          activity = nextActivity
        },
        releaseIfIdle() {
          if (!next.busy) release()
        },
      }
      data.runners.set(sessionID, entry)
      return entry
    })

    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing?.runner.busy) yield* busyError(sessionID)
    })

    const promote = Effect.fn("SessionRunState.promote")(function* (sessionID: SessionID) {
      yield* promoteChildJobs(background, sessionID)
    })

    const cancel = Effect.fn("SessionRunState.cancel")(function* (sessionID: SessionID) {
      // 先将直接子任务转为后台以释放同步等待，再停止 Runner；子代理仅由 task_async_abort 显式终止。
      yield* promote(sessionID)
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (!existing) {
        yield* status.set(sessionID, { type: "idle" })
        return
      }
      yield* existing.runner.cancel
    })

    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
    ) {
      const directory = yield* InstanceState.directory
      return yield* Effect.acquireUseRelease(
        Effect.promise((signal) => acquireInstanceActivity(directory, signal)),
        (activity) =>
          Effect.gen(function* () {
            const entry = yield* runner(sessionID, onInterrupt)
            entry.activate(activity)
            return yield* entry.runner.ensureRunning(work).pipe(Effect.ensuring(Effect.sync(entry.releaseIfIdle)))
          }),
        (activity) => Effect.sync(activity.release),
      )
    })

    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
      ready?: Latch.Latch,
    ) {
      const directory = yield* InstanceState.directory
      return yield* Effect.acquireUseRelease(
        Effect.promise((signal) => acquireInstanceActivity(directory, signal)),
        (activity) =>
          Effect.gen(function* () {
            const entry = yield* runner(sessionID, onInterrupt)
            entry.activate(activity)
            return yield* entry.runner.startShell(work, ready).pipe(
              Effect.catchTag("RunnerBusy", () => Effect.fail(busyError(sessionID))),
              Effect.ensuring(Effect.sync(entry.releaseIfIdle)),
            )
          }),
        (activity) => Effect.sync(activity.release),
      )
    })

    return Service.of({ assertNotBusy, promote, cancel, ensureRunning, startShell })
  }),
)

const promoteChildJobs = Effect.fn("SessionRunState.promoteChildJobs")(function* (
  background: BackgroundJob.Interface,
  sessionID: SessionID,
) {
  const jobs = yield* background.list()
  yield* Effect.forEach(
    jobs.filter(
      (job) =>
        job.status === "running" &&
        (job.metadata?.sessionId === sessionID || job.metadata?.parentSessionId === sessionID),
    ),
    (job) => background.promote(job.id),
    { concurrency: "unbounded", discard: true },
  )
})

function busyError(sessionID: SessionID) {
  return new Session.BusyError({ sessionID })
}

export const node = LayerNode.make({ service: Service, layer: layer, deps: [BackgroundJob.node, SessionStatus.node] })

export * as SessionRunState from "./run-state"
