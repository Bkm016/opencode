import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Runner } from "@/effect/runner"
import { BackgroundJob } from "@/background/job"
import { Deferred, Effect, Latch, Layer, Scope, Context, SynchronizedRef, Semaphore } from "effect"
import { Session } from "./session"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"
import { acquireInstanceActivity, type InstanceActivity } from "@/effect/instance-registry"

/** 单次 task_async_wait 注册：独立 release Deferred，finally 注销。 */
export type WaitRegistration = {
  readonly token: symbol
  readonly released: Deferred.Deferred<void>
}

type WaitEntry = {
  token: symbol
  /** tool callID；缺失时仍可被 onUserPrompt 释放，但不参与 sticky。 */
  callID?: string
  released: Deferred.Deferred<void>
}

/** 每会话 waiter 与按 callID 的 sticky（仅覆盖已 running 但尚未 register 的 wait）。 */
type SessionWaits = {
  waiters: Map<symbol, WaitEntry>
  stickyCallIDs: Set<string>
}

export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  /**
   * 用户消息已持久化后调用：提升前台子任务，并协作式释放本会话 active async wait。
   * runningCallIDs 为当前仍 running 的 task_async_wait 的 callID；仅这些未注册的调用可 sticky。
   */
  readonly onUserPrompt: (sessionID: SessionID, runningCallIDs?: readonly string[]) => Effect.Effect<void>
  /** 原子注册一次 wait；callID 用于消费匹配的 sticky。 */
  readonly registerWait: (sessionID: SessionID, callID?: string) => Effect.Effect<WaitRegistration>
  readonly unregisterWait: (sessionID: SessionID, token: symbol) => Effect.Effect<void>
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
  // 每会话 admission 临界区：createUserMessage 与 synthetic claim 共用，防止并发竞态
  readonly admit: <A, E, R>(sessionID: SessionID, work: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
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
        // SynchronizedRef：register / release / unregister 在无交叉 yield 的临界区内完成。
        const waits = yield* SynchronizedRef.make(new Map<SessionID, SessionWaits>())
        // 每会话 admission 信号量：createUserMessage 与 synthetic claim 共用，防止并发竞态
        const admissionSemaphores = new Map<SessionID, Semaphore.Semaphore>()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            yield* Effect.forEach(runners.values(), (entry) => entry.runner.cancel, {
              concurrency: "unbounded",
              discard: true,
            })
            runners.clear()
            admissionSemaphores.clear()
            const snapshot = yield* SynchronizedRef.get(waits)
            for (const session of snapshot.values()) {
              for (const entry of session.waiters.values()) {
                yield* Deferred.succeed(entry.released, undefined).pipe(Effect.ignore)
              }
            }
            yield* SynchronizedRef.set(waits, new Map())
          }),
        )
        return { runners, waits, scope, admissionSemaphores }
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

    const isEmpty = (session: SessionWaits) => session.waiters.size === 0 && session.stickyCallIDs.size === 0

    const registerWait = Effect.fn("SessionRunState.registerWait")(function* (
      sessionID: SessionID,
      callID?: string,
    ) {
      const data = yield* InstanceState.get(state)
      const token = Symbol("task_async_wait")
      const released = yield* Deferred.make<void>()
      // modify 临界区内纯同步：仅匹配 callID 的 sticky 可立即完成。
      const immediate = yield* SynchronizedRef.modify(data.waits, (map) => {
        const current = map.get(sessionID) ?? { waiters: new Map(), stickyCallIDs: new Set<string>() }
        if (callID && current.stickyCallIDs.has(callID)) {
          const stickyCallIDs = new Set(current.stickyCallIDs)
          stickyCallIDs.delete(callID)
          const next: SessionWaits = { waiters: current.waiters, stickyCallIDs }
          const copy = new Map(map)
          if (isEmpty(next)) copy.delete(sessionID)
          else copy.set(sessionID, next)
          return [true, copy] as const
        }
        const waiters = new Map(current.waiters)
        waiters.set(token, { token, callID, released })
        const copy = new Map(map)
        copy.set(sessionID, { waiters, stickyCallIDs: current.stickyCallIDs })
        return [false, copy] as const
      })
      if (immediate) yield* Deferred.succeed(released, undefined).pipe(Effect.ignore)
      return { token, released } satisfies WaitRegistration
    })

    const unregisterWait = Effect.fn("SessionRunState.unregisterWait")(function* (
      sessionID: SessionID,
      token: symbol,
    ) {
      const data = yield* InstanceState.get(state)
      yield* SynchronizedRef.update(data.waits, (map) => {
        const current = map.get(sessionID)
        if (!current || !current.waiters.has(token)) return map
        const waiters = new Map(current.waiters)
        waiters.delete(token)
        const next: SessionWaits = { waiters, stickyCallIDs: current.stickyCallIDs }
        const copy = new Map(map)
        if (isEmpty(next)) copy.delete(sessionID)
        else copy.set(sessionID, next)
        return copy
      })
    })

    // 唤醒全部 active waiter；仅为 runningCallIDs 中尚未注册的 call 写 sticky。
    const releaseWaits = Effect.fn("SessionRunState.releaseWaits")(function* (
      sessionID: SessionID,
      runningCallIDs: readonly string[],
    ) {
      const data = yield* InstanceState.get(state)
      const pending = yield* SynchronizedRef.modify(data.waits, (map) => {
        const current = map.get(sessionID) ?? { waiters: new Map(), stickyCallIDs: new Set<string>() }
        const entries = [...current.waiters.values()]
        const registered = new Set(
          entries.flatMap((entry) => (entry.callID ? [entry.callID] : [])),
        )
        // runningCallIDs 是当前权威快照；旧 sticky 不在其中时直接淘汰。
        const stickyCallIDs = new Set(runningCallIDs.filter((id) => !registered.has(id)))

        const next: SessionWaits = {
          waiters: new Map(),
          stickyCallIDs,
        }
        const copy = new Map(map)
        if (isEmpty(next)) copy.delete(sessionID)
        else copy.set(sessionID, next)
        return [entries, copy] as const
      })
      yield* Effect.forEach(pending, (entry) => Deferred.succeed(entry.released, undefined).pipe(Effect.ignore), {
        concurrency: "unbounded",
        discard: true,
      })
    })

    const onUserPrompt = Effect.fn("SessionRunState.onUserPrompt")(function* (
      sessionID: SessionID,
      runningCallIDs: readonly string[] = [],
    ) {
      yield* promoteChildJobs(background, sessionID)
      // 已是 background 的 job 上 promote 幂等；release 负责协作式结束 task_async_wait。
      yield* releaseWaits(sessionID, runningCallIDs)
    })

    const cancel = Effect.fn("SessionRunState.cancel")(function* (sessionID: SessionID) {
      // 仅提升子任务并停 Runner；不发布「新用户消息」式 wait release（避免 released 语义误用）。
      yield* promoteChildJobs(background, sessionID)
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

    // 每会话 admission 临界区：createUserMessage 与 synthetic claim 共用
    const admit = function <A, E, R>(sessionID: SessionID, work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
      return Effect.gen(function* () {
        const data = yield* InstanceState.get(state)
        let sem = data.admissionSemaphores.get(sessionID)
        if (!sem) {
          sem = Semaphore.makeUnsafe(1)
          data.admissionSemaphores.set(sessionID, sem)
        }
        return yield* sem.withPermit(work)
      })
    }

    return Service.of({
      assertNotBusy,
      onUserPrompt,
      registerWait,
      unregisterWait,
      cancel,
      ensureRunning,
      startShell,
      admit,
    })
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
