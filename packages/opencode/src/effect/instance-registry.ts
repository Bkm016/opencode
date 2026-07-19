const disposers = new Set<(directory: string) => Promise<void>>()

// 配置热重载必须等运行租约全部释放；显式 dispose 不经过此门，仍可立即终止进程资源。
type ActivityGate = {
  active: number
  reloading: boolean
  idle: Set<() => void>
  ready: Set<() => void>
}

const activities = new Map<string, ActivityGate>()

function activityGate(directory: string) {
  const existing = activities.get(directory)
  if (existing) return existing
  const gate: ActivityGate = {
    active: 0,
    reloading: false,
    idle: new Set(),
    ready: new Set(),
  }
  activities.set(directory, gate)
  return gate
}

function wait(waiters: Set<() => void>, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      waiters.delete(complete)
      signal?.removeEventListener("abort", abort)
    }
    const complete = () => {
      cleanup()
      resolve()
    }
    const abort = () => {
      cleanup()
      reject(new DOMException("Aborted", "AbortError"))
    }
    if (signal?.aborted) {
      abort()
      return
    }
    waiters.add(complete)
    signal?.addEventListener("abort", abort, { once: true })
  })
}

export interface InstanceActivity {
  retain(): void
  release(): void
}

export async function acquireInstanceActivity(directory: string, signal?: AbortSignal): Promise<InstanceActivity> {
  const gate = activityGate(directory)
  while (gate.reloading) await wait(gate.ready, signal)
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
  gate.active += 1
  let references = 1
  return {
    retain() {
      // 调用方把租约交给 detached Runner 后，双方各自释放一次，避免请求断开提前放行 reload。
      if (references === 0) return
      references += 1
    },
    release() {
      if (references === 0) return
      references -= 1
      if (references > 0) return
      gate.active -= 1
      if (gate.active > 0) return
      for (const complete of [...gate.idle]) complete()
    },
  }
}

export async function beginInstanceReload(directory: string, signal?: AbortSignal): Promise<() => void> {
  const gate = activityGate(directory)
  while (gate.reloading) await wait(gate.ready, signal)
  gate.reloading = true
  try {
    while (gate.active > 0) await wait(gate.idle, signal)
  } catch (error) {
    gate.reloading = false
    for (const complete of [...gate.ready]) complete()
    throw error
  }
  let released = false
  return () => {
    if (released) return
    released = true
    gate.reloading = false
    for (const complete of [...gate.ready]) complete()
  }
}

export function registerDisposer(disposer: (directory: string) => Promise<void>) {
  disposers.add(disposer)
  return () => {
    disposers.delete(disposer)
  }
}

export async function disposeInstance(directory: string) {
  await Promise.allSettled([...disposers].map((disposer) => disposer(directory)))
}
