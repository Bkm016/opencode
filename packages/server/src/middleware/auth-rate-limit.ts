import { Effect, Option } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

const FAILURE_LIMIT = 30
const FAILURE_WINDOW_MS = 60_000
const TRACKED_ADDRESSES = 1024

export function createAuthFailureTracker(
  input: { limit?: number; window?: number; capacity?: number; now?: () => number } = {},
) {
  const limit = input.limit ?? FAILURE_LIMIT
  const window = input.window ?? FAILURE_WINDOW_MS
  const capacity = input.capacity ?? TRACKED_ADDRESSES
  const now = input.now ?? Date.now
  // Map 按插入顺序迭代，而过期时间在插入时确定，因此最早插入的记录也最早过期。
  const failures = new Map<string, { count: number; expires: number }>()

  const sweep = () => {
    const time = now()
    for (const [key, value] of failures) {
      if (value.expires > time) break
      failures.delete(key)
    }
  }

  return {
    blocked(address: string) {
      sweep()
      return (failures.get(address)?.count ?? 0) >= limit
    },
    record(address: string) {
      sweep()
      const current = failures.get(address)
      if (current) {
        current.count += 1
        return
      }
      // 表满时淘汰最早的记录，不能拒绝新来源：否则攻击者用足够多的地址填满表，
      // 持有正确密码的用户也会被 429 挡在门外。
      if (failures.size >= capacity) failures.delete(failures.keys().next().value!)
      failures.set(address, { count: 1, expires: now() + window })
    },
    size() {
      return failures.size
    },
  }
}

export const authRateLimit = HttpRouter.middleware(
  Effect.sync(() => {
    const tracker = createAuthFailureTracker()
    return (effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        // 只信任连接地址；反向代理后的客户端共享额度，不能用可伪造的转发头绕过。
        const address = Option.getOrElse(request.remoteAddress, () => "unknown")
        if (tracker.blocked(address)) {
          return HttpServerResponse.empty({ status: 429, headers: { "retry-after": String(FAILURE_WINDOW_MS / 1000) } })
        }
        const response = yield* effect
        if (response.status === 401) tracker.record(address)
        return response
      })
  }),
  { global: true },
)
