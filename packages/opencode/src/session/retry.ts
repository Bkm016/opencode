import type { NamedError } from "@opencode-ai/core/util/error"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Clock, Context, Deferred, Duration, Effect, Layer, Schedule } from "effect"
import { InstanceState } from "@/effect/instance-state"
import type { SessionID } from "./schema"
import { iife } from "@/util/iife"
import { isRecord } from "@/util/record"

export type Err = ReturnType<NamedError["toObject"]>

export const GO_UPSELL_MESSAGE = "Free usage exceeded, subscribe to Go"
export const GO_UPSELL_URL = "https://opencode.ai/go"
export type RetryReason = "free_tier_limit" | "account_rate_limit" | (string & {})

export type Retryable = {
  message: string
  action?: {
    reason: RetryReason
    provider: string
    title: string
    message: string
    label: string
    link?: string
  }
}

export const RETRY_INITIAL_DELAY = 2000
export const RETRY_BACKOFF_FACTOR = 2
export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout

function cap(ms: number) {
  return Math.min(ms, RETRY_MAX_DELAY)
}

export function delay(attempt: number, error?: SessionV1.APIError) {
  if (error) {
    const headers = error.data.responseHeaders
    if (headers) {
      const retryAfterMs = headers["retry-after-ms"]
      if (retryAfterMs) {
        const parsedMs = Number.parseFloat(retryAfterMs)
        if (!Number.isNaN(parsedMs)) {
          return cap(parsedMs)
        }
      }

      const retryAfter = headers["retry-after"]
      if (retryAfter) {
        const parsedSeconds = Number.parseFloat(retryAfter)
        if (!Number.isNaN(parsedSeconds)) {
          // convert seconds to milliseconds
          return cap(Math.ceil(parsedSeconds * 1000))
        }
        // Try parsing as HTTP date format
        const parsed = Date.parse(retryAfter) - Date.now()
        if (!Number.isNaN(parsed) && parsed > 0) {
          return cap(Math.ceil(parsed))
        }
      }

      return cap(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1))
    }
  }

  return cap(Math.min(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), RETRY_MAX_DELAY_NO_HEADERS))
}

function isAuthFailure(status: number | undefined) {
  return status === 401 || status === 403
}

function shouldRetryApiError(error: SessionV1.APIError) {
  if (error.data.isRetryable) return true
  const status = error.data.statusCode
  if (status === undefined) return false
  // Auth failures need a new credential, not another attempt.
  if (isAuthFailure(status)) return false
  // 5xx and common transient client/gateway statuses keep retrying without a cap.
  // 400 is included: providers often surface transient upstream faults as Bad Request.
  if (status >= 500) return true
  return status === 400 || status === 408 || status === 409 || status === 425 || status === 429
}

function messageText(error: Err) {
  const msg = isRecord(error.data) ? error.data.message : undefined
  return typeof msg === "string" ? msg : undefined
}

function isTransientMessage(msg: string) {
  const lower = msg.toLowerCase()
  if (
    lower.includes("rate increased too quickly") ||
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("overloaded") ||
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("etimedout") ||
    lower.includes("socket hang up") ||
    lower.includes("network connection was lost") ||
    lower.includes("network request failed") ||
    lower.includes("failed to fetch") ||
    lower.includes("fetch failed") ||
    lower.includes("connection reset") ||
    lower.includes("connection ended") ||
    lower.includes("connection closed") ||
    lower.includes("other side closed") ||
    lower === "terminated" ||
    lower.startsWith("terminated (") ||
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("temporarily unavailable") ||
    lower.includes("service unavailable") ||
    lower.includes("bad gateway") ||
    lower.includes("gateway timeout") ||
    lower.includes("internal server error") ||
    lower.includes("provider unavailable")
  ) {
    return true
  }
  if (lower.includes("stream") && (lower.includes("closed") || lower.includes("aborted") || lower.includes("interrupted"))) {
    return true
  }
  return lower.includes("failed to read") && lower.includes("stream")
}

export function retryable(error: Err, provider: string) {
  // context overflow errors should not be retried
  if (SessionV1.ContextOverflowError.isInstance(error)) return undefined
  // User abort and missing credentials are terminal.
  if (SessionV1.AbortedError.isInstance(error)) return undefined
  if (SessionV1.AuthError.isInstance(error)) return undefined
  if (SessionV1.APIError.isInstance(error)) {
    if (!shouldRetryApiError(error)) return undefined
    if (error.data.responseBody?.includes("FreeUsageLimitError")) {
      return {
        message: GO_UPSELL_MESSAGE,
        action: {
          reason: "free_tier_limit",
          provider,
          title: "Free limit reached",
          message: "Subscribe to OpenCode Go for reliable access to the best open-source models, starting at $5/month.",
          label: "subscribe",
          link: GO_UPSELL_URL,
        },
      }
    }
    if (error.data.responseBody?.includes("GoUsageLimitError")) {
      const body = parseJSON(error.data.responseBody)
      const workspace = str(body?.metadata?.workspace)
      const limitName = str(body?.metadata?.limitName)
      const retryAfter = num(error.data.responseHeaders?.["retry-after"])
      const resetIn = iife(() => {
        if (retryAfter === undefined) return ""
        const seconds = Math.max(0, Math.ceil(retryAfter))
        const days = Math.floor(seconds / 86_400)
        const hours = Math.floor((seconds % 86_400) / 3_600)
        const minutes = Math.ceil((seconds % 3_600) / 60)
        const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? "" : "s"}`

        if (days > 0) return hours > 0 ? `${unit(days, "day")} ${unit(hours, "hour")}` : unit(days, "day")
        if (hours > 0) return minutes > 0 ? `${unit(hours, "hour")} ${unit(minutes, "minute")}` : unit(hours, "hour")
        return minutes > 0 ? unit(minutes, "minute") : "less than a minute"
      })

      const message = `${limitName ? `${limitName} usage limit` : "Usage limit"} reached. It will reset in ${resetIn}. To continue using this model now, enable usage from your available balance`

      const link = `https://opencode.ai/workspace/${workspace}/go`
      return {
        message: `${message} - ${link}`,
        action: {
          reason: "account_rate_limit",
          provider,
          title: "Go limit reached",
          message,
          label: "open settings",
          link,
        },
      }
    }
    const body = error.data.responseBody?.trim()
    if (body && !error.data.message.includes(body)) {
      return { message: `${error.data.message}: ${body}` }
    }
    return { message: error.data.message }
  }

  // Check for rate limit / transport patterns in plain text error messages
  const msg = messageText(error)
  if (typeof msg === "string" && isTransientMessage(msg)) {
    return { message: msg }
  }

  const json = parseJSON(msg)
  if (!json || typeof json !== "object") return undefined
  const code = typeof json.code === "string" ? json.code : ""

  if (json.type === "error" && json.error?.type === "too_many_requests") {
    return { message: "Too Many Requests" }
  }
  if (code.includes("exhausted") || code.includes("unavailable")) {
    return { message: "Provider is overloaded" }
  }
  if (json.type === "error" && typeof json.error?.code === "string" && json.error.code.includes("rate_limit")) {
    return { message: "Rate Limited" }
  }
  return undefined
}

function str(value: unknown) {
  if (value === undefined || value === null) return ""
  return String(value)
}

function num(value: unknown) {
  const parsed = Number.parseFloat(str(value))
  if (Number.isNaN(parsed)) return undefined
  return parsed
}

function parseJSON(value: unknown) {
  return iife(() => {
    try {
      if (typeof value !== "string") return undefined
      return JSON.parse(value)
    } catch {
      return undefined
    }
  })
}

export function policy(opts: {
  provider: string
  parse: (error: unknown) => Err
  set: (input: { attempt: number; message: string; action?: Retryable["action"]; next: number }) => Effect.Effect<void>
  // 自动退避与会话级主动唤醒在这里竞争，Schedule 本身不再重复休眠。
  wait: (ms: number, ready: Effect.Effect<void>) => Effect.Effect<void>
}) {
  return Schedule.fromStepWithMetadata(
    Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
      const error = opts.parse(meta.input)
      const retry = retryable(error, opts.provider)
      if (!retry) return Cause.done(meta.attempt)
      return Effect.gen(function* () {
        const waitMs = delay(meta.attempt, SessionV1.APIError.isInstance(error) ? error : undefined)
        const now = yield* Clock.currentTimeMillis
        // wait() 已负责休眠和主动唤醒，返回零延迟避免 Effect.retry 再等待一次。
        yield* opts.wait(
          waitMs,
          opts.set({
            attempt: meta.attempt,
            message: retry.message,
            action: retry.action,
            next: now + waitMs,
          }),
        )
        return [meta.attempt, Duration.zero] as [number, Duration.Duration]
      })
    }),
  )
}

export interface Interface {
  // 注册唤醒器后执行 ready，再等待指定时长或由同一会话的 wake() 提前唤醒。
  readonly wait: (sessionID: SessionID, ms: number, ready: Effect.Effect<void>) => Effect.Effect<void>
  // 先执行 beforeWake 再结束进行中的等待；当前没有等待时返回 false。
  readonly wake: (sessionID: SessionID, beforeWake: Effect.Effect<void>) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRetry") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make(
      Effect.fn("SessionRetry.state")(() => Effect.succeed(new Map<SessionID, Deferred.Deferred<void>>())),
    )

    const wait = Effect.fn("SessionRetry.wait")(function* (
      sessionID: SessionID,
      ms: number,
      ready: Effect.Effect<void>,
    ) {
      const data = yield* InstanceState.get(state)
      const previous = data.get(sessionID)
      if (previous) {
        data.delete(sessionID)
        yield* Deferred.succeed(previous, undefined).pipe(Effect.ignore)
      }
      const deferred = yield* Deferred.make<void>()
      data.set(sessionID, deferred)
      yield* Effect.gen(function* () {
        yield* ready
        yield* Effect.raceFirst(Effect.sleep(Duration.millis(ms)), Deferred.await(deferred))
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (data.get(sessionID) === deferred) data.delete(sessionID)
          }),
        ),
      )
    })

    const wake = Effect.fn("SessionRetry.wake")(function* (sessionID: SessionID, beforeWake: Effect.Effect<void>) {
      const data = yield* InstanceState.get(state)
      const deferred = data.get(sessionID)
      if (!deferred) return false
      data.delete(sessionID)
      yield* beforeWake
      yield* Deferred.succeed(deferred, undefined).pipe(Effect.ignore)
      return true
    })

    return Service.of({ wait, wake })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })

export * as SessionRetry from "./retry"
