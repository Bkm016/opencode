import { AppProcess } from "@opencode-ai/core/process"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { which } from "@opencode-ai/core/util/which"
import { ChildProcess } from "effect/unstable/process"
import { Effect, Schema } from "effect"
import path from "path"
import { InstanceState } from "@/effect/instance-state"
import { containsPath } from "@/project/instance-context"
import * as Tool from "./tool"
import DESCRIPTION from "./python.txt"

const DEFAULT_TIMEOUT = 2 * 60 * 1000

export const Parameters = Schema.Struct({
  code: Schema.String.annotate({ description: "Python source code to execute directly; do not pass a file path" }),
  args: Schema.optional(Schema.Array(Schema.String))
    .annotate({ description: "Arguments passed to the Python script" })
    .pipe(Schema.withDecodingDefault(Effect.succeed([] as string[]))),
  workdir: Schema.optional(Schema.String).annotate({
    description: "Working directory, relative to the project directory",
  }),
  timeout: Schema.optional(Schema.Number).annotate({ description: "Timeout in milliseconds (default: 120000)" }),
})

export const PythonTool = Tool.define(
  "python",
  Effect.gen(function* () {
    const appProcess = yield* AppProcess.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const cwd = path.resolve(instance.directory, params.workdir ?? ".")
          const timeout = params.timeout ?? DEFAULT_TIMEOUT

          if (!Number.isFinite(timeout) || timeout < 0) {
            throw new Error(`Invalid timeout value: ${timeout}. Timeout must be a non-negative number.`)
          }

          const externalDirectories = Array.from(
            new Set(
              [cwd]
                .filter((directory) => !containsPath(directory, instance))
                .map((directory) =>
                  process.platform === "win32"
                    ? FSUtil.normalizePathPattern(path.join(directory, "*"))
                    : path.join(directory, "*"),
                ),
            ),
          )
          if (externalDirectories.length > 0) {
            yield* ctx.ask({
              permission: "external_directory",
              patterns: externalDirectories,
              always: externalDirectories,
              metadata: {
                workdir: cwd,
              },
            })
          }

          yield* ctx.ask({
            permission: "python",
            patterns: [cwd],
            always: [cwd],
            metadata: {
              args: params.args,
              workdir: cwd,
              timeout,
            },
          })

          const candidates = process.platform === "win32" ? ["python", "python3", "py"] : ["python3", "python"]
          const interpreter = candidates.map((name) => ({ name, path: which(name) })).find((item) => item.path)
          if (!interpreter?.path) {
            throw new Error("Python interpreter not found. Install Python and make it available on PATH.")
          }

          const interpreterArgs = interpreter.name === "py" ? ["-3"] : []
          const result = yield* appProcess.run(
            ChildProcess.make(interpreter.path, [...interpreterArgs, "-u", "-c", params.code, ...(params.args ?? [])], {
              cwd,
              env: {
                PYTHONIOENCODING: "utf-8",
                PYTHONUTF8: "1",
              },
              extendEnv: true,
              stdin: "ignore",
            }),
            {
              signal: ctx.abort,
              timeout: `${timeout} millis`,
            },
          )

          const stdout = result.stdout.toString("utf8")
          const stderr = result.stderr.toString("utf8")
          const output = [stdout, stderr].filter((text) => text.length > 0).join("\n") || "(no output)"

          return {
            title: `${interpreter.name} -c`,
            metadata: {
              exit: result.exitCode,
              interpreter: interpreter.path,
              workdir: cwd,
            },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
