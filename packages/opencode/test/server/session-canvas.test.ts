import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import path from "path"
import fs from "fs/promises"
import { Session } from "@/session/session"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(Layer.mergeAll(LayerNode.compile(Session.node), httpApiLayer))

afterEach(async () => {
  await disposeAllInstances()
})

const createAssistant = Effect.fn("test.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  dir: string,
  agent = "build",
) {
  const sessionSvc = yield* Session.Service
  const messageID = MessageID.ascending()
  const msg: SessionV1.Assistant = {
    id: messageID,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID,
    modelID: ModelV2.ID.make("test-model"),
    providerID: ProviderV2.ID.make("test-provider"),
    mode: "code",
    agent,
    path: { cwd: dir, root: dir },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    finish: "end_turn",
  }
  yield* sessionSvc.updateMessage(msg)
  return messageID
})

describe("session canvas endpoint", () => {
  it.instance(
    "returns live document content for completed canvas tool part",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const sessionSvc = yield* Session.Service
        const sessionInfo = yield* sessionSvc.create({})
        const messageID = yield* createAssistant(sessionInfo.id, MessageID.ascending(), test.directory)
        const partID = PartID.ascending()

        const docPath = path.join(test.directory, "architecture.md")
        const initialContent = "# Architecture Initial"
        const liveContent = "# Architecture Updated\n\n```mermaid\nflowchart TD\n  A --> B\n```"
        yield* Effect.promise(() => fs.writeFile(docPath, liveContent, "utf-8"))

        const normPath = FSUtil.normalizePath(docPath)
        yield* sessionSvc.updatePart({
          id: partID,
          sessionID: sessionInfo.id,
          messageID,
          type: "tool",
          callID: "call_canvas_1",
          tool: "canvas",
          state: {
            status: "completed",
            input: { path: "architecture.md" },
            title: "System Architecture",
            output: `Opened canvas for System Architecture (${normPath})`,
            metadata: {
              path: normPath,
              canonicalPath: normPath,
              title: "System Architecture",
              content: initialContent,
            },
            time: { start: Date.now(), end: Date.now() },
          },
        } satisfies SessionV1.ToolPart)

        // 请求 live refresh 端点
        const res = yield* requestInDirectory(`/session/${sessionInfo.id}/canvas/${partID}`, test.directory)
        expect(res.status).toBe(200)

        const data = (yield* res.json) as { path: string; title: string; content: string }
        expect(data.path).toBe(normPath)
        expect(data.title).toBe("System Architecture")
        // 成功读取磁盘最新的实时内容，而非旧快照
        expect(data.content).toBe(liveContent)
      }),
    { git: true },
  )

  it.instance(
    "returns 404 when session or part does not exist",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const sessionSvc = yield* Session.Service
        const sessionInfo = yield* sessionSvc.create({})

        // 不存在的 session
        const resMissingSession = yield* requestInDirectory(
          `/session/ses_missing/canvas/${PartID.ascending()}`,
          test.directory,
        )
        expect(resMissingSession.status).toBe(404)

        // 存在的 session 但不存在的 part
        const resMissingPart = yield* requestInDirectory(
          `/session/${sessionInfo.id}/canvas/${PartID.ascending()}`,
          test.directory,
        )
        expect(resMissingPart.status).toBe(404)
      }),
    { git: true },
  )

  it.instance(
    "enforces cross-session boundary: cannot access part belonging to another session",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const sessionSvc = yield* Session.Service
        const sessionA = yield* sessionSvc.create({})
        const sessionB = yield* sessionSvc.create({})
        const messageID = yield* createAssistant(sessionA.id, MessageID.ascending(), test.directory)
        const partID = PartID.ascending()

        const docPath = path.join(test.directory, "cross.md")
        yield* Effect.promise(() => fs.writeFile(docPath, "# Content", "utf-8"))
        const normPath = FSUtil.normalizePath(docPath)

        yield* sessionSvc.updatePart({
          id: partID,
          sessionID: sessionA.id,
          messageID,
          type: "tool",
          callID: "call_cross",
          tool: "canvas",
          state: {
            status: "completed",
            input: { path: "cross.md" },
            title: "Cross Doc",
            output: "ok",
            metadata: {
              path: normPath,
              canonicalPath: normPath,
              title: "Cross Doc",
              content: "# Content",
            },
            time: { start: Date.now(), end: Date.now() },
          },
        } satisfies SessionV1.ToolPart)

        // 通过 sessionB 尝试访问 sessionA 的 part，必须返回 404
        const res = yield* requestInDirectory(`/session/${sessionB.id}/canvas/${partID}`, test.directory)
        expect(res.status).toBe(404)
      }),
    { git: true },
  )

  it.instance(
    "returns 400 if part is not completed canvas tool",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const sessionSvc = yield* Session.Service
        const sessionInfo = yield* sessionSvc.create({})
        const messageID = yield* createAssistant(sessionInfo.id, MessageID.ascending(), test.directory)
        const runningPartID = PartID.ascending()
        const nonCanvasPartID = PartID.ascending()

        // running 状态的 canvas 工具
        yield* sessionSvc.updatePart({
          id: runningPartID,
          sessionID: sessionInfo.id,
          messageID,
          type: "tool",
          callID: "call_running",
          tool: "canvas",
          state: {
            status: "running",
            input: { path: "doc.md" },
            time: { start: Date.now() },
          },
        } satisfies SessionV1.ToolPart)

        // 非 canvas 工具 (write)
        yield* sessionSvc.updatePart({
          id: nonCanvasPartID,
          sessionID: sessionInfo.id,
          messageID,
          type: "tool",
          callID: "call_write",
          tool: "write",
          state: {
            status: "completed",
            input: { filePath: "doc.md", content: "..." },
            title: "doc.md",
            output: "ok",
            metadata: {},
            time: { start: Date.now(), end: Date.now() },
          },
        } satisfies SessionV1.ToolPart)

        const resRunning = yield* requestInDirectory(
          `/session/${sessionInfo.id}/canvas/${runningPartID}`,
          test.directory,
        )
        expect(resRunning.status).toBe(400)

        const resNonCanvas = yield* requestInDirectory(
          `/session/${sessionInfo.id}/canvas/${nonCanvasPartID}`,
          test.directory,
        )
        expect(resNonCanvas.status).toBe(400)
      }),
    { git: true },
  )

  it.instance(
    "returns 400 when read permission is explicitly denied",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const sessionSvc = yield* Session.Service
        // 创建会话并明确设置拒绝 read 权限
        const sessionInfo = yield* sessionSvc.create({
          permission: [
            {
              action: "deny",
              permission: "read",
              pattern: "*",
            },
          ],
        })
        const messageID = yield* createAssistant(sessionInfo.id, MessageID.ascending(), test.directory)
        const partID = PartID.ascending()

        const docPath = path.join(test.directory, "denied.md")
        yield* Effect.promise(() => fs.writeFile(docPath, "# Denied", "utf-8"))
        const normPath = FSUtil.normalizePath(docPath)

        yield* sessionSvc.updatePart({
          id: partID,
          sessionID: sessionInfo.id,
          messageID,
          type: "tool",
          callID: "call_perm",
          tool: "canvas",
          state: {
            status: "completed",
            input: { path: "denied.md" },
            title: "Denied Doc",
            output: "ok",
            metadata: {
              path: normPath,
              canonicalPath: normPath,
              title: "Denied Doc",
              content: "# Denied",
            },
            time: { start: Date.now(), end: Date.now() },
          },
        } satisfies SessionV1.ToolPart)

        const res = yield* requestInDirectory(`/session/${sessionInfo.id}/canvas/${partID}`, test.directory)
        expect(res.status).toBe(400)
      }),
    { git: true },
  )

  it.instance(
    "returns 400 when live file is deleted or symlink target is retargeted (fail-closed)",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const sessionSvc = yield* Session.Service
        const sessionInfo = yield* sessionSvc.create({})
        const messageID = yield* createAssistant(sessionInfo.id, MessageID.ascending(), test.directory)
        const partID = PartID.ascending()

        const fileA = path.join(test.directory, "targetA.md")
        const fileB = path.join(test.directory, "targetB.md")
        const linkDoc = path.join(test.directory, "swapped.md")
        yield* Effect.promise(() => fs.writeFile(fileA, "# Target A", "utf-8"))
        yield* Effect.promise(() => fs.writeFile(fileB, "# Target B", "utf-8"))
        yield* Effect.promise(() => fs.symlink(fileA, linkDoc))

        const normLink = FSUtil.normalizePath(linkDoc)
        const normCanonicalA = FSUtil.normalizePath(fileA)

        yield* sessionSvc.updatePart({
          id: partID,
          sessionID: sessionInfo.id,
          messageID,
          type: "tool",
          callID: "call_symlink_change",
          tool: "canvas",
          state: {
            status: "completed",
            input: { path: "swapped.md" },
            title: "Swapped",
            output: "ok",
            metadata: {
              path: normLink,
              canonicalPath: normCanonicalA,
              title: "Swapped",
              content: "# Target A",
            },
            time: { start: Date.now(), end: Date.now() },
          },
        } satisfies SessionV1.ToolPart)

        // 恶意将符号链接换向指向 targetB
        yield* Effect.promise(() => fs.unlink(linkDoc))
        yield* Effect.promise(() => fs.symlink(fileB, linkDoc))

        // 端点核查预期 canonicalPath 不匹配，必须 fail-closed 返回 400，严禁静默返回
        const resSwapped = yield* requestInDirectory(`/session/${sessionInfo.id}/canvas/${partID}`, test.directory)
        expect(resSwapped.status).toBe(400)

        // 若直接删除文件，也必须 fail-closed 返回 400，前端靠快照兜底
        yield* Effect.promise(() => fs.unlink(linkDoc))
        const resDeleted = yield* requestInDirectory(`/session/${sessionInfo.id}/canvas/${partID}`, test.directory)
        expect(resDeleted.status).toBe(400)
      }),
    { git: true },
  )
})
