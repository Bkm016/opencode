import { Effect, Option } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

export const authRateLimit = HttpRouter.middleware(
  Effect.sync(() => {
    const failures = new Map<string, { count: number; expires: number }>()
    return (effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        // 只信任连接地址；反向代理后的客户端共享额度，不能用可伪造的转发头绕过。
        const address = Option.getOrElse(request.remoteAddress, () => "unknown")
        const now = Date.now()
        for (const [key, value] of failures) {
          if (value.expires <= now) failures.delete(key)
        }
        const entry = failures.get(address)
        // 达到容量时拒绝新来源，避免攻击者用地址轮换驱逐既有封禁记录。
        if ((entry && entry.count >= 30) || (!entry && failures.size >= 1024)) {
          return HttpServerResponse.empty({ status: 429, headers: { "retry-after": "60" } })
        }
        const response = yield* effect
        if (response.status === 401) {
          const current = failures.get(address)
          if (current) current.count += 1
          if (!current && failures.size < 1024) failures.set(address, { count: 1, expires: Date.now() + 60_000 })
        }
        return response
      })
  }),
  { global: true },
)
