import path from "node:path"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { Cause, Effect, Exit, FileSystem, Schema, Semaphore } from "effect"
import { Tool } from "./tool"
import { ToolJsonSchema } from "./json-schema"
import { INTERRUPTED, open, record, type Method, type Turn, type WindowsComputerUse } from "./computer-use-windows"

const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))
const Index = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Window = Schema.Struct({ app: Identifier, id: Index })
const Screenshot = Schema.optional(Identifier).annotate({
  description: "Screenshot ID from the latest get_window_state for this window.",
})

export const Parameters = Schema.Union([
  Schema.Struct({ action: Schema.Literal("list_windows") }),
  Schema.Struct({ action: Schema.Literal("list_apps") }),
  Schema.Struct({ action: Schema.Literal("activate_window"), window: Window }),
  Schema.Struct({ action: Schema.Literal("get_window"), window: Window }),
  Schema.Struct({
    action: Schema.Literal("get_window_state"),
    window: Window,
    include_text: Schema.optional(Schema.Boolean).annotate({
      description: "Include accessibility text and element indices (default true).",
    }),
    include_screenshot: Schema.optional(Schema.Boolean).annotate({
      description: "Include screenshots as image attachments (default true).",
    }),
  }),
  Schema.Struct({
    action: Schema.Literal("click"),
    window: Window,
    element_index: Schema.optional(Index),
    x: Schema.optional(Schema.Int),
    y: Schema.optional(Schema.Int),
    screenshotId: Screenshot,
    mouse_button: Schema.optional(Schema.Literals(["left", "right", "middle", "l", "r", "m"])),
    click_count: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 }))),
  }),
  Schema.Struct({
    action: Schema.Literal("type_text"),
    window: Window,
    text: Schema.String.check(Schema.isMaxLength(100_000)),
  }),
  Schema.Struct({
    action: Schema.Literal("press_key"),
    window: Window,
    key: Identifier.annotate({
      description: "X keysym-style key or chord, e.g. Return, Tab, Control_L+a, Control_L+Shift_L+period.",
    }),
  }),
  Schema.Struct({
    action: Schema.Literal("scroll"),
    window: Window,
    x: Schema.Int,
    y: Schema.Int,
    scrollX: Schema.Int.annotate({ description: "Horizontal delta: negative left, positive right." }),
    scrollY: Schema.Int.annotate({ description: "Vertical delta: negative up, positive down." }),
    screenshotId: Screenshot,
  }),
  Schema.Struct({
    action: Schema.Literal("drag"),
    window: Window,
    from_x: Schema.Int,
    from_y: Schema.Int,
    to_x: Schema.Int,
    to_y: Schema.Int,
    screenshotId: Screenshot,
  }),
  Schema.Struct({ action: Schema.Literal("launch_app"), app: Identifier }),
  Schema.Struct({
    action: Schema.Literal("set_value"),
    window: Window,
    element_index: Index,
    value: Schema.String.check(Schema.isMaxLength(100_000)),
  }),
  Schema.Struct({
    action: Schema.Literal("perform_secondary_action"),
    window: Window,
    element_index: Index,
    secondary_action: Identifier.annotate({
      description: "Secondary action label observed on this element in the latest accessibility tree.",
    }),
  }),
])

type Observation = {
  helper: WindowsComputerUse
  turn: string
  app: string
  windowID: number
  revision: number
  time: number
  text: boolean
  screenshots: string[]
}

// 所有工作区与会话共享真实桌面，锁与 Esc 锁存不能按 InstanceState 隔离。
const desktop = {
  lock: Semaphore.makeUnsafe(1),
  helper: undefined as WindowsComputerUse | undefined,
  observation: undefined as Observation | undefined,
  stopped: new Map<string, Set<string>>(),
}

export const ComputerUseTool = Tool.define(
  "computer_use",
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    // 部分提供方不接受顶层 anyOf；模型描述由同一联合派生，执行时仍严格校验各动作必需字段。
    const jsonSchema = {
      type: "object",
      properties: {
        ...Object.fromEntries(
          Parameters.members.flatMap((member) => Object.entries(ToolJsonSchema.fromSchema(member).properties ?? {})),
        ),
        action: { type: "string", enum: Parameters.members.map((member) => member.fields.action.literal) },
      },
      required: ["action"],
    } satisfies JSONSchema7
    return {
      description: `Control applications on the OpenCode server's local Windows desktop using the installed Codex runtime, not a remote client's desktop.
Before first use, load the computer-use skill through the skill tool for the workflow and recovery rules. If unavailable or denied, stop rather than bypassing it.
Requires permission. Physical Escape stops computer use for the entire current user turn.`,
      parameters: Parameters,
      jsonSchema,
      execute: (input: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        desktop.lock.withPermits(1)(
          Effect.gen(function* () {
            if (process.platform !== "win32") {
              throw new Error("computer_use is supported only on a local Windows desktop server.")
            }
            const user = ctx.messages.findLast(
              (message) =>
                message.info.role === "user" &&
                !message.parts.some((part) => part.type === "compaction") &&
                !message.parts.every((part) => "synthetic" in part && part.synthetic),
            )
            const turn: Turn = { session_id: ctx.sessionID, turn_id: user?.info.id ?? "unknown-user-turn" }
            const key = `${turn.session_id}\0${turn.turn_id}`
            if (desktop.stopped.get(turn.session_id)?.has(turn.turn_id)) throw new Error(INTERRUPTED)
            if (ctx.abort.aborted) throw new Error("Computer use was cancelled; no action was sent.")
            const app = "window" in input ? input.window.app : "app" in input ? input.app : undefined
            if (app !== undefined && !app.trim()) {
              throw new Error("App must be a non-empty identifier from list_windows or an explicit .exe path.")
            }
            const metadata = { action: input.action, ...(app ? { app } : {}) }
            // 权限面板只展示 patterns；保留独立 app 匹配以免操作详情绕过已有应用 deny 规则。
            const detail = `${input.action}: ${JSON.stringify(input)}`
            yield* ctx.metadata({ title: app ? `${input.action}: ${app}` : input.action, metadata })
            yield* ctx.ask({
              permission: "computer_use",
              patterns: [app ?? input.action, detail],
              always: [app ?? input.action, `${input.action}: *`],
              metadata: { ...input },
            })
            if (ctx.abort.aborted) throw new Error("Computer use was cancelled; no action was sent.")
            if (desktop.stopped.get(turn.session_id)?.has(turn.turn_id)) throw new Error(INTERRUPTED)
            const previous = desktop.helper
            if (previous && !previous.usable) {
              yield* Effect.promise(() => previous.stop())
              desktop.helper = undefined
              desktop.observation = undefined
            }
            if (!desktop.helper) {
              desktop.helper = yield* open(fs, (stopped) => {
                const turns = desktop.stopped.get(stopped.session_id) ?? new Set<string>()
                turns.add(stopped.turn_id)
                desktop.stopped.set(stopped.session_id, turns)
                desktop.observation = undefined
              })
            }
            const helper = desktop.helper
            // 只读取官方 Esc 标记；不创建或修改 Codex 的中断、认证与授权文件。
            const marker = path.join(
              helper.codexHome,
              "cache",
              "computer-use",
              "interrupts",
              turn.session_id.replace(/[^A-Za-z0-9._-]/g, "_"),
              turn.turn_id.replace(/[^A-Za-z0-9._-]/g, "_"),
            )
            if (yield* fs.exists(marker)) {
              helper.onInterrupt(turn)
              yield* Effect.promise(() => helper.stop())
              throw new Error(INTERRUPTED)
            }
            if (helper.turn && (helper.turn.session_id !== turn.session_id || helper.turn.turn_id !== turn.turn_id)) {
              desktop.observation = undefined
              const ended = yield* helper.request("end_turn", {}, helper.turn, ctx.abort)
              if (ended.approvalRequest)
                throw new Error("Codex could not end the previous desktop turn without approval.")
            }

            const observed = desktop.observation
            // 恢复窗口不能依赖恢复后才能取得的截图；它仍经过上方相同的权限检查。
            const mutation = input.action !== "get_window_state" && input.action !== "list_windows" &&
              input.action !== "list_apps" && input.action !== "activate_window" && input.action !== "get_window"
            if (mutation && "window" in input) {
              if (
                !observed ||
                observed.helper !== helper ||
                observed.turn !== key ||
                observed.app !== input.window.app ||
                observed.windowID !== input.window.id ||
                observed.revision !== helper.revision ||
                Date.now() - observed.time > 60_000 ||
                (!observed.text && !observed.screenshots.length)
              ) {
                throw new Error(
                  "Window state is missing or stale. Call get_window_state and inspect it before acting; do not replay an earlier action.",
                )
              }
              if ("element_index" in input && input.element_index !== undefined && !observed.text) {
                throw new Error("Element actions require a fresh get_window_state with include_text: true.")
              }
              if (
                input.action === "scroll" ||
                input.action === "drag" ||
                (input.action === "click" && input.element_index === undefined)
              ) {
                if (!observed.screenshots.length)
                  throw new Error("Coordinate actions require a fresh screenshot observation.")
                if (
                  input.screenshotId
                    ? !observed.screenshots.includes(input.screenshotId)
                    : observed.screenshots.length !== 1
                ) {
                  throw new Error(
                    "Specify a screenshotId from the latest get_window_state; stale or ambiguous screenshots cannot be used.",
                  )
                }
              }
            }
            const request = command(input, observed)
            desktop.observation = undefined
            if (desktop.stopped.get(turn.session_id)?.has(turn.turn_id)) throw new Error(INTERRUPTED)
            let reply = yield* helper.request(request.method, request.params, turn, ctx.abort)
            if (reply.approvalRequest) {
              const approval = reply.approvalRequest
              // 此元数据仅能在真实 OpenCode 权限检查成功后发送；不继承环境中的 Codex 批准值。
              yield* ctx.ask({
                permission: "computer_use",
                patterns: [
                  approval.app,
                  `${detail}; Codex app approval: ${approval.displayName}; risk: ${approval.riskLevel ?? "unspecified"}`,
                ],
                always: [approval.app, `${input.action}: *`],
                metadata: {
                  ...input,
                  app: approval.app,
                  displayName: approval.displayName,
                  riskLevel: approval.riskLevel,
                  approval: true,
                },
              })
              if (desktop.stopped.get(turn.session_id)?.has(turn.turn_id) || (yield* fs.exists(marker))) {
                helper.onInterrupt(turn)
                yield* Effect.promise(() => helper.stop())
                throw new Error(INTERRUPTED)
              }
              if (
                mutation &&
                "window" in input &&
                (!observed || Date.now() - observed.time > 60_000 || observed.revision !== helper.revision)
              ) {
                throw new Error("Window state expired during approval. Observe it again; the action was not retried.")
              }
              reply = yield* helper.request(request.method, request.params, turn, ctx.abort, approval.app)
              if (reply.approvalRequest)
                throw new Error("Codex requested another approval; no further automatic retry was attempted.")
            }
            const projected = project(reply.result)
            if (input.action === "get_window_state") {
              if (!record(reply.result) || !Array.isArray(reply.result.screenshots))
                throw new Error("Codex returned an invalid window state.")
              const window = record(reply.result.window) ? reply.result.window : undefined
              // 官方 helper 可以规范化 app 并返回字符串句柄；仍校验同一窗口，后续动作重新检查规范化应用的权限。
              if (
                window &&
                ((typeof window.id !== "number" && typeof window.id !== "string") ||
                  String(window.id).trim() === "" ||
                  Number(window.id) !== input.window.id)
              ) {
                throw new Error("Codex returned state for a different window; no action is permitted.")
              }
              desktop.observation = {
                helper,
                turn: key,
                app: typeof window?.app === "string" && window.app.trim() ? window.app : input.window.app,
                windowID: input.window.id,
                revision: reply.revision,
                time: Date.now(),
                text:
                  (input.include_text ?? true) &&
                  record(reply.result.accessibility) &&
                  typeof reply.result.accessibility.tree === "string" &&
                  !!reply.result.accessibility.tree.trim(),
                screenshots: projected.screenshots,
              }
            }
            return {
              title: app ? `${input.action}: ${app}` : input.action,
              metadata,
              output: projected.output ?? `${input.action} completed. Observe the window again before the next action.`,
              attachments: projected.attachments,
            }
          }).pipe(
            Effect.onExit((exit) => {
              if (Exit.isSuccess(exit)) return Effect.void
              desktop.observation = undefined
              const helper = desktop.helper
              // 业务错误仅废弃观察；只有中断或失效传输才关闭进程，避免吞掉可恢复错误。
              return helper && (!helper.usable || ctx.abort.aborted || Cause.hasInterrupts(exit.cause))
                ? Effect.promise(() => helper.stop())
                : Effect.void
            }),
            Effect.orDie,
          ),
        ),
    }
  }),
)

// 唯一的公共动作到官方 helper 方法映射；不接受模型提供任意方法或 meta。
function command(
  input: Schema.Schema.Type<typeof Parameters>,
  observed?: Observation,
): { method: Method; params: Record<string, unknown> } {
  switch (input.action) {
    case "list_windows":
    case "list_apps":
      return { method: input.action, params: {} }
    case "set_value":
      return { method: input.action, params: { window: input.window, element_index: input.element_index, value: input.value } }
    case "perform_secondary_action": {
      // 外层 action 是工具判别字段，只有此处将 secondary_action 映射到原生协议的 action。
      const action = input.secondary_action.trim()
      if (!action) throw new Error("secondary_action must be a label from the current accessibility tree.")
      return { method: input.action, params: { window: input.window, element_index: input.element_index, action } }
    }
    case "get_window":
      return { method: input.action, params: { id: input.window.id, app: input.window.app } }
    case "activate_window":
      return { method: input.action, params: { window: input.window } }
    case "get_window_state": {
      const include_text = input.include_text ?? true
      const include_screenshot = input.include_screenshot ?? true
      if (!include_text && !include_screenshot) throw new Error("Request include_text, include_screenshot, or both.")
      return { method: input.action, params: { window: input.window, include_text, include_screenshot } }
    }
    case "click": {
      const click = {
        window: input.window,
        click_count: input.click_count ?? 1,
        mouse_button: input.mouse_button ?? "left",
      }
      if (input.element_index !== undefined) {
        if (input.x !== undefined || input.y !== undefined || input.screenshotId !== undefined)
          throw new Error("Element clicks cannot also specify coordinates or screenshotId.")
        return { method: "click_element", params: { ...click, element_index: input.element_index } }
      }
      if (input.x === undefined || input.y === undefined)
        throw new Error("click requires element_index or both x and y.")
      return {
        method: "click",
        params: { ...click, x: input.x, y: input.y, screenshotId: input.screenshotId ?? observed?.screenshots[0] },
      }
    }
    case "scroll":
      return {
        method: input.action,
        params: {
          window: input.window,
          x: input.x,
          y: input.y,
          scrollX: input.scrollX,
          scrollY: input.scrollY,
          screenshotId: input.screenshotId ?? observed?.screenshots[0],
        },
      }
    case "drag":
      return {
        method: input.action,
        params: {
          window: input.window,
          from_x: input.from_x,
          from_y: input.from_y,
          to_x: input.to_x,
          to_y: input.to_y,
          screenshotId: input.screenshotId ?? observed?.screenshots[0],
        },
      }
    case "type_text":
      return { method: input.action, params: { window: input.window, text: input.text } }
    case "press_key": {
      const key = input.key
        .split("+")
        .map((part) => part.trim())
        .filter(Boolean)
        .join("+")
      if (!key) throw new Error("press_key requires a non-empty key or chord.")
      return { method: input.action, params: { window: input.window, key } }
    }
    case "launch_app":
      return { method: input.action, params: { app: input.app } }
  }
}

// 只接受内嵌图片并验证编码与文件签名；绝不读取任意路径或抓取 helper 返回的 URL。
function project(result: unknown) {
  const attachments: NonNullable<Tool.ExecuteResult["attachments"]> = []
  const screenshots: string[] = []
  if (record(result) && Array.isArray(result.screenshots)) {
    for (const screenshot of result.screenshots) {
      if (
        !record(screenshot) ||
        typeof screenshot.id !== "string" ||
        !screenshot.id ||
        typeof screenshot.url !== "string"
      ) {
        throw new Error("Codex returned an invalid screenshot.")
      }
      if (screenshots.includes(screenshot.id)) throw new Error("Codex returned ambiguous duplicate screenshot IDs.")
      const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(screenshot.url)
      if (!match || match[2].length > 32 * 1024 * 1024)
        throw new Error("Screenshot must be a bounded PNG, JPEG, or WebP base64 data URL.")
      const bytes = Buffer.from(match[2], "base64")
      if (bytes.toString("base64") !== match[2]) throw new Error("Screenshot contains invalid base64.")
      const valid =
        match[1] === "image/png"
          ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : match[1] === "image/jpeg"
            ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
            : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP"
      if (!valid) throw new Error("Screenshot bytes do not match the declared image type.")
      screenshots.push(screenshot.id)
      attachments.push({
        type: "file",
        mime: match[1],
        url: screenshot.url,
        filename: `computer-use-${attachments.length + 1}.${match[1].split("/")[1]}`,
      })
    }
  }
  const output =
    result === undefined || result === null
      ? undefined
      : JSON.stringify(
          result,
          (key, value: unknown) => {
            if (key === "base64") return "[image data omitted; see attachments]"
            if (typeof value === "string" && value.startsWith("data:image/"))
              return "[image data omitted; see attachments]"
            return value
          },
          2,
        )
  return { output, attachments, screenshots }
}
