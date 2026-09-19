import { expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Config, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { Workspace } from "../../src/control-plane/workspace"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { Session } from "@/session/session"
import { SessionTransfer } from "@/session/transfer"
import { Database } from "@opencode-ai/core/database/database"
import { afterEach } from "bun:test"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const noopBootstrapLayer = Layer.succeed(
  InstanceBootstrapService.Service,
  InstanceBootstrapService.Service.of({ run: Effect.void }),
)
const appLayer = AppNodeBuilder.build(
  LayerNode.group([InstanceStore.node, Project.node, Session.node, Workspace.node, Database.node, Ripgrep.node]),
  [[InstanceStore.bootstrapNode, noopBootstrapLayer]],
)
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  {
    disableListenLog: true,
    disableLogger: true,
  },
)
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(Layer.mergeAll(appLayer, httpApiLayer))

function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname + url.search),
    HttpClient.execute,
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

it.instance(
  "session import/export static routes survive workspace session-id routing",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const headers = { "x-opencode-directory": test.directory }
      const session = yield* Session.use.create({ title: "transfer-route-test" })
      const bundle = yield* SessionTransfer.exportBundle(session.id)

      // /session/:sessionID/export 的段是真实会话 ID，走会话路由。
      const exported = yield* request(
        SessionPaths.exportBundle.replace(":sessionID", session.id),
        { headers },
      )
      expect(exported.status).toBe(200)

      // /session/import 的段是静态路径，必须按无会话处理，不能把 "import" 当 SessionID 解码成 500。
      const imported = yield* request(SessionPaths.importBundle, {
        headers,
        method: "POST",
        body: JSON.stringify(bundle),
      })
      expect(imported.status).toBe(200)
      const info = (yield* imported.json) as Session.Info
      expect(info.id).toBe(session.id)
      expect(info.directory).toBe(test.directory)

      yield* Session.use.remove(session.id)
    }),
  { git: true, config: { formatter: false, lsp: false } },
)
