import { describe, expect } from "bun:test"
import path from "path"
import * as fs from "fs/promises"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Layer } from "effect"
import { MultiEditTool } from "../../src/tool/multiedit"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { TestInstance } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([FSUtil.node, Format.node, EventV2Bridge.node, Truncate.node, Agent.node]),
  ),
)

const ctx = {
  sessionID: SessionID.make("ses_test-multiedit"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const execute = Effect.fn("MultiEditToolTest.execute")(function* (edits: unknown[]) {
  const info = yield* MultiEditTool
  const tool = yield* info.init()
  return yield* tool.execute({ edits }, ctx)
})

const readText = (filepath: string) => Effect.promise(() => fs.readFile(filepath, "utf-8"))
const writeText = (filepath: string, content: string) => Effect.promise(() => fs.writeFile(filepath, content, "utf-8"))

const expectFailure = <A, E, R>(effect: Effect.Effect<A, E, R>, message?: string) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && message) expect(Cause.pretty(exit.cause)).toContain(message)
  })

describe("tool.multiedit", () => {
  it.instance(
    "applies valid edits when another file fails",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const ok = path.join(test.directory, "ok.txt")
        yield* writeText(ok, "line1\nline2\n")

        const result = yield* execute([
          { filePath: "ok.txt", oldString: "line2", newString: "changed" },
          { filePath: "missing.txt", oldString: "nope", newString: "x" },
        ])

        expect(result.output).toContain("M ok.txt")
        expect(result.output).toContain("Failed to apply 1 edit")
        expect(result.output).toContain("missing.txt")
        expect(yield* readText(ok)).toBe("line1\nchanged\n")
      }),
    { git: true },
  )

  it.instance(
    "reports unmatched oldString and still writes other files",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const a = path.join(test.directory, "a.txt")
        const b = path.join(test.directory, "b.txt")
        yield* writeText(a, "alpha\n")
        yield* writeText(b, "beta\n")

        const result = yield* execute([
          { filePath: "a.txt", oldString: "does-not-exist", newString: "x" },
          { filePath: "b.txt", oldString: "beta", newString: "gamma" },
        ])

        expect(result.output).toContain("M b.txt")
        expect(result.output).toContain("Failed to apply 1 edit")
        expect(result.output).toContain("a.txt")
        expect(yield* readText(b)).toBe("gamma\n")
        expect(yield* readText(a)).toBe("alpha\n")
      }),
    { git: true },
  )

  it.instance(
    "fails when every edit fails",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const target = path.join(test.directory, "t.txt")
        yield* writeText(target, "content\n")

        yield* expectFailure(
          execute([{ filePath: "t.txt", oldString: "nope", newString: "x" }]),
          "no edits could be applied",
        )
        expect(yield* readText(target)).toBe("content\n")
      }),
    { git: true },
  )

  it.instance(
    "fails cleanly when the only file's edits all fail",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const target = path.join(test.directory, "multi.txt")
        yield* writeText(target, "one\ntwo\nthree\n")

        yield* expectFailure(
          execute([
            { filePath: "multi.txt", oldString: "missing", newString: "x" },
            { filePath: "multi.txt", oldString: "two", newString: "TWO" },
          ]),
          "edits[0] (multi.txt)",
        )
        expect(yield* readText(target)).toBe("one\ntwo\nthree\n")
      }),
    { git: true },
  )

  it.instance(
    "keeps earlier successful edits on a file when a later one fails",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const target = path.join(test.directory, "multi.txt")
        yield* writeText(target, "one\ntwo\nthree\n")

        const result = yield* execute([
          { filePath: "multi.txt", oldString: "one", newString: "ONE" },
          { filePath: "multi.txt", oldString: "missing", newString: "x" },
          { filePath: "multi.txt", oldString: "three", newString: "THREE" },
        ])

        expect(result.output).toContain("M multi.txt")
        expect(result.output).toContain("Failed to apply 1 edit")
        expect(result.output).toContain("edits[1] (multi.txt)")
        expect(yield* readText(target)).toBe("ONE\ntwo\nthree\n")
      }),
    { git: true },
  )
})
