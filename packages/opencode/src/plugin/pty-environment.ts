export * as PluginPtyEnvironment from "./pty-environment"

import { PtyEnvironment } from "@opencode-ai/server/pty-environment"
import { Effect, Layer } from "effect"
import { InstanceStore } from "@/project/instance-store"
import { Plugin } from "."
import { Skill } from "@/skill"

export const layer = Layer.effect(
  PtyEnvironment.Service,
  Effect.gen(function* () {
    const plugin = yield* Plugin.Service
    const instances = yield* InstanceStore.Service
    const skills = yield* Skill.Service
    return PtyEnvironment.Service.of({
      get: Effect.fn("PtyEnvironment.get")(function* (input) {
        return yield* instances.provide(
          { directory: input.directory },
          Effect.gen(function* () {
            const env = (yield* plugin.trigger("shell.env", { cwd: input.cwd }, { env: {} as Record<string, string> }))
              .env
            // 终端里也能直接用技能 bin/ 里的命令
            return { ...env, ...Skill.pathEnv(env, yield* skills.binDirs()) }
          }),
        )
      }),
    })
  }),
)
