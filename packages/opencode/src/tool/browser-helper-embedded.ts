// 单文件二进制内嵌的 helper 入口：把 playwright-core 静态打进 helper，
// 使其在没有 node_modules 的机器上（opencode serve 单文件部署）也能运行。
import * as core from "playwright-core"
import * as registry from "playwright-core/lib/server/registry/index"

Object.assign(globalThis, { __opencodePlaywright: { core, registry } })
await import("./browser-helper")
