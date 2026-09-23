import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Agent } from "../../src/agent/agent"
import { SessionID, MessageID } from "../../src/session/schema"
import { BrowserTool } from "../../src/tool/browser"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { disposeAllInstances, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// browser 工具跨实例共享一个 helper 子进程（真实 Chromium），
// 用 instance 测试驱动真实 navigate；结束时 close 兜底回收浏览器。
afterEach(async () => {
  await disposeAllInstances()
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(LayerNode.group([Agent.node, FSUtil.node, CrossSpawnSpawner.node, Truncate.node])),
    testInstanceStoreLayer,
  ),
)

const init = Effect.fn("BrowserToolTest.init")(function* () {
  const info = yield* BrowserTool
  return yield* info.init()
})

const run = Effect.fn("BrowserToolTest.run")(function* (
  args: Tool.InferParameters<typeof BrowserTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const fail = Effect.fn("BrowserToolTest.fail")(function* (
  args: Tool.InferParameters<typeof BrowserTool>,
  next: Tool.Context = ctx,
) {
  const exit = yield* run(args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected browser action to fail")
})

describe("browser tabs", () => {
  it.instance("tabs and global close bypass tab-target interception", () =>
    Effect.gen(function* () {
      const first = yield* run({ action: "navigate", url: "https://example.com" })
      const second = yield* run({ action: "navigate", url: "https://example.org", new_tab: true })
      expect(first.metadata.tab).toBeDefined()
      expect(second.metadata.tab).toBeDefined()
      expect(second.metadata.tab).not.toBe(first.metadata.tab)

      // 多 tab 时 tabs 必须能直接列出，不得被目标 tab 校验拦截。
      const listed = yield* run({ action: "tabs" })
      expect(listed.output).toContain(String(first.metadata.tab))
      expect(listed.output).toContain(String(second.metadata.tab))
      expect(listed.output).toContain("example.org")

      // 不带 tab 的交互动作仍须拦截，防止多页时猜错目标。
      const ambiguous = yield* fail({ action: "get_content" })
      expect(ambiguous.message).toContain("Multiple browser tabs are open")

      // 多 tab 时不带 tab 的 close 是全局关闭，不得被目标 tab 校验拦截。
      const closed = yield* run({ action: "close" })
      expect(closed.output).toContain("Closed the browser")

      const empty = yield* run({ action: "tabs" })
      expect(empty.output).toContain("No browser tab is open")
    }),
  )
})
