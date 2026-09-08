import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit } from "effect"
import path from "path"
import fs from "fs/promises"
import { CanvasTool } from "../../src/tool/canvas"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { Agent } from "../../src/agent/agent"
import { SessionID, MessageID } from "../../src/session/schema"
import { disposeAllInstances, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// 默认测试工具上下文
const makeCtx = (onAsk?: (req: Parameters<Tool.Context["ask"]>[0]) => void): Tool.Context => ({
  sessionID: SessionID.make("ses_test-canvas-session"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: (req) => {
    onAsk?.(req)
    return Effect.void
  },
})

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Truncate.node, Agent.node])))

describe("CanvasTool", () => {
  it.instance("opens valid markdown file and produces metadata snapshot", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const docPath = path.join(test.directory, "overview.md")
      const docContent = "# Architecture\n\n```mermaid\nflowchart TD\n  A --> B\n```"
      yield* Effect.promise(() => fs.writeFile(docPath, docContent, "utf-8"))

      const definition = yield* CanvasTool
      const tool = yield* definition.init()
      const exit = yield* Effect.exit(tool.execute({ path: "overview.md" }, makeCtx()))
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        const result = exit.value
        expect(result.title).toBe("overview.md")
        expect(result.output).toContain("Opened canvas for overview.md")
        expect(result.output).not.toContain(docContent)
        expect(result.metadata.path).toBe(FSUtil.normalizePath(docPath))
        expect(result.metadata.canonicalPath).toBe(FSUtil.normalizePath(docPath))
        expect(result.metadata.title).toBe("overview.md")
        expect(result.metadata.content).toBe(docContent)
      }
    }),
  )

  it.instance("supports custom title parameter", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const docPath = path.join(test.directory, "spec.markdown")
      yield* Effect.promise(() => fs.writeFile(docPath, "# Spec", "utf-8"))

      const definition = yield* CanvasTool
      const tool = yield* definition.init()
      const exit = yield* Effect.exit(
        tool.execute({ path: "spec.markdown", title: "Project Specification" }, makeCtx()),
      )
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        const result = exit.value
        expect(result.title).toBe("Project Specification")
        expect(result.output).toContain("Project Specification")
        expect(result.metadata.title).toBe("Project Specification")
        expect(result.metadata.content).toBe("# Spec")
      }
    }),
  )

  it.instance("authorizes canonical target when opening symlinked file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const realDoc = path.join(test.directory, "real.md")
      const linkDoc = path.join(test.directory, "link.md")
      yield* Effect.promise(() => fs.writeFile(realDoc, "# Real Target", "utf-8"))
      yield* Effect.promise(() => fs.symlink(realDoc, linkDoc))

      const requestedPatterns: string[] = []
      const definition = yield* CanvasTool
      const tool = yield* definition.init()
      const exit = yield* Effect.exit(
        tool.execute(
          { path: "link.md" },
          makeCtx((req) => requestedPatterns.push(...req.patterns)),
        ),
      )

      expect(Exit.isSuccess(exit)).toBe(true)
      // 必须对真实物理目标与链接路径均进行授权校验
      expect(requestedPatterns).toContain("real.md")
      expect(requestedPatterns).toContain("link.md")
    }),
  )

  it.instance("rejects non-markdown files with failure cause", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const txtPath = path.join(test.directory, "notes.txt")
      yield* Effect.promise(() => fs.writeFile(txtPath, "text", "utf-8"))

      const definition = yield* CanvasTool
      const tool = yield* definition.init()
      const exit = yield* Effect.exit(tool.execute({ path: "notes.txt" }, makeCtx()))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause) as Error
        expect(error.message).toContain("Only Markdown files")
      }
    }),
  )

  it.instance("rejects non-existent files with failure cause", () =>
    Effect.gen(function* () {
      const definition = yield* CanvasTool
      const tool = yield* definition.init()
      const exit = yield* Effect.exit(tool.execute({ path: "missing.md" }, makeCtx()))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause) as Error
        expect(error.message).toContain("File not found")
      }
    }),
  )

  it.instance("rejects directory paths with failure cause", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dirPath = path.join(test.directory, "sub.md")
      yield* Effect.promise(() => fs.mkdir(dirPath))

      const definition = yield* CanvasTool
      const tool = yield* definition.init()
      const exit = yield* Effect.exit(tool.execute({ path: "sub.md" }, makeCtx()))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause) as Error
        expect(error.message).toContain("Path is not a regular file")
      }
    }),
  )

  it.instance("rejects files exceeding 256 KiB size limit with failure cause", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const largePath = path.join(test.directory, "large.md")
      const largeContent = "x".repeat(256 * 1024 + 1)
      yield* Effect.promise(() => fs.writeFile(largePath, largeContent, "utf-8"))

      const definition = yield* CanvasTool
      const tool = yield* definition.init()
      const exit = yield* Effect.exit(tool.execute({ path: "large.md" }, makeCtx()))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause) as Error
        expect(error.message).toContain("256 KB")
      }
    }),
  )

  it.instance("rejects symlink targets escaping workspace boundary", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      // 指向工作区外的临时目录文件
      const outside = yield* tmpdirScoped()
      const outsideDoc = path.join(outside, "outside.md")
      yield* Effect.promise(() => fs.writeFile(outsideDoc, "# Outside", "utf-8"))
      const linkDoc = path.join(test.directory, "escape.md")
      yield* Effect.promise(() => fs.symlink(outsideDoc, linkDoc))

      const definition = yield* CanvasTool
      const tool = yield* definition.init()
      const exit = yield* Effect.exit(tool.execute({ path: "escape.md" }, makeCtx()))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause) as Error
        expect(error.message).toContain("Access denied")
      }
    }),
  )

  it.instance("reads after approval and still bounds a file that grew during authorization", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const filepath = path.join(instance.directory, "growing.md")
      yield* Effect.promise(() => fs.writeFile(filepath, "# Small"))
      const definition = yield* CanvasTool
      const tool = yield* definition.init()
      const exit = yield* Effect.exit(
        tool.execute(
          { path: "growing.md" },
          {
            ...makeCtx(),
            ask: () => Effect.promise(() => fs.writeFile(filepath, "x".repeat(256 * 1024 + 1))),
          },
        ),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(String(Cause.squash(exit.cause))).toContain("UTF-8 limit")
      }
    }),
  )
})
