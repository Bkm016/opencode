import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Effect, Layer } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { WorkspaceRouteContext } from "./workspace-routing"

export class InstanceContextMiddleware extends HttpApiMiddleware.Service<
  InstanceContextMiddleware,
  {
    requires: WorkspaceRouteContext
  }
>()("@opencode/ExperimentalHttpApiInstanceContext") {}

// 只读端点：只需要 InstanceContext（project 解析结果），不依赖 config/plugin
// bootstrap 完成。首屏 session.list / session.status / project.current / path.get
// 走 peek 跳过 plugin.init 等待，写操作和 config 相关端点仍走完整 load。
const LIGHT_ENDPOINTS = new Set([
  "session.list",
  "session.status",
  "session.get",
  "session.children",
  "session.todo",
  "session.diff",
  "session.messages",
  "session.message",
  "project.list",
  "project.current",
  "project.directories",
  "instance.path",
  // config.get / app.agents 只读 InstanceState，不等 plugin.init —— 插件通过 hook
  // 读取 config，不回写状态，首屏返回的是同一份快照。
  "config.get",
  "app.agents",
])

function decode(input: string): string {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

function provideInstanceContext<E>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E>,
  store: InstanceStore.Interface,
  options: { readonly group: { readonly identifier: string }; readonly endpoint: { readonly name: string } },
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, WorkspaceRouteContext> {
  return Effect.gen(function* () {
    const route = yield* WorkspaceRouteContext
    const key = `${options.group.identifier}.${options.endpoint.name}`
    const input = { directory: decode(route.directory) }
    const ctx = LIGHT_ENDPOINTS.has(key) ? yield* store.peek(input) : yield* store.load(input)
    return yield* effect.pipe(
      Effect.provideService(InstanceRef, ctx),
      Effect.provideService(WorkspaceRef, route.workspaceID),
    )
  })
}

export const instanceContextLayer = Layer.effect(
  InstanceContextMiddleware,
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    return InstanceContextMiddleware.of((effect, options) => provideInstanceContext(effect, store, options))
  }),
)
