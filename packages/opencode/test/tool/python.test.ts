import { AppProcess } from "@opencode-ai/core/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { which } from "@opencode-ai/core/util/which"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { Plugin } from "../../src/plugin"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { PythonTool } from "../../src/tool/python"
import { Tool } from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { MessageID, SessionID } from "../../src/session/schema"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const pythonCandidates = process.platform === "win32" ? ["python", "python3", "py"] : ["python3", "python"]
const hasPython = pythonCandidates.some((candidate) => which(candidate) !== null)

const pythonLayer = Layer.mergeAll(
  LayerNode.compile(
    LayerNode.group([
      CrossSpawnSpawner.node,
      AppProcess.node,
      Config.node,
      Plugin.node,
      Truncate.node,
      Agent.node,
      RuntimeFlags.node,
    ]),
  ),
  testInstanceStoreLayer,
)
const it = testEffect(pythonLayer)

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const run = Effect.fn("PythonToolTest.run")(function* (
  args: Tool.InferParameters<typeof PythonTool>,
  next: Tool.Context = ctx,
) {
  const python = yield* PythonTool
  const tool = yield* python.init()
  return yield* tool.execute(args, next)
})

describe.skipIf(!hasPython)("tool.python", () => {
  it.live("runs a script with arguments and captures stderr", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const result = yield* run({
        code: [
          "import os",
          "import sys",
          "print(os.getcwd())",
          "print(sys.argv[1])",
          "print('stderr output', file=sys.stderr)",
        ].join("\n"),
        args: ["argument"],
      }).pipe(provideInstance(directory))

      expect(result.metadata.exit).toBe(0)
      expect(result.output).toContain(directory)
      expect(result.output).toContain("argument")
      expect(result.output).toContain("stderr output")
    }),
  )

  it.live("returns a non-zero script exit code", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const result = yield* run({ code: "raise SystemExit(7)" }).pipe(provideInstance(directory))

      expect(result.metadata.exit).toBe(7)
    }),
  )
})
