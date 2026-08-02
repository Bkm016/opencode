import { CommandV2 } from "@opencode-ai/core/command"
import { Location } from "@opencode-ai/core/location"
import { RunScript } from "@opencode-ai/core/run-script"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const CommandHandler = HttpApiBuilder.group(Api, "server.command", (handlers) =>
  Effect.gen(function* () {
    return handlers.handle("command.list", () =>
      Effect.gen(function* () {
        const command = yield* CommandV2.Service
        const location = yield* Location.Service
        const commands = yield* command.list()
        const directory = location.vcs ? location.project.directory : location.directory
        const filepath = RunScript.filePath(directory)
        // run.json 缺失或解析失败都视为无运行脚本，不影响命令列表本身。
        const value = yield* Effect.promise(() => Bun.file(filepath).json()).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        )
        const scripts =
          value === undefined
            ? undefined
            : yield* RunScript.parseEffect(filepath, value).pipe(Effect.catch(() => Effect.succeed(undefined)))
        const runCommands = Object.entries(scripts ?? {}).map(([name, template]) => ({
          name,
          template,
          source: "run" as const,
        }))
        return yield* response(Effect.succeed([...commands, ...runCommands]))
      }),
    )
  }),
)
