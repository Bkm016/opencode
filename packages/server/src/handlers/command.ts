import { CommandV2 } from "@opencode-ai/core/command"
import { Location } from "@opencode-ai/core/location"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"
import path from "path"

export const CommandHandler = HttpApiBuilder.group(Api, "server.command", (handlers) =>
  Effect.gen(function* () {
    return handlers.handle("command.list", () =>
      Effect.gen(function* () {
        const command = yield* CommandV2.Service
        const location = yield* Location.Service
        const commands = yield* command.list()
        const directory = location.vcs ? location.project.directory : location.directory
        const runPath = path.join(directory, ".opencode", "run.json")
        const value = yield* Effect.promise(() => Bun.file(runPath).json()).pipe(Effect.catch(() => Effect.succeed(undefined)))
        const scripts =
          typeof value === "object" && value !== null && !Array.isArray(value) && "scripts" in value
            ? value.scripts
            : value
        const runCommands =
          typeof scripts === "object" && scripts !== null && !Array.isArray(scripts)
            ? Object.entries(scripts).flatMap(([name, template]) =>
                name === "$schema" || typeof template !== "string"
                  ? []
                  : [{ name, template, source: "run" as const }],
              )
            : []
        console.info(`[run] list path: ${runPath}; scripts: ${runCommands.map((item) => item.name).join(", ")}`)
        return yield* response(Effect.succeed([...commands, ...runCommands]))
      }),
    )
  }),
)
