import { DeployKey } from "@opencode-ai/core/deploy-key"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const DeployKeyHandler = HttpApiBuilder.group(Api, "server.deployKey", (handlers) =>
  Effect.gen(function* () {
    const deployKey = yield* DeployKey.Service

    return handlers.handle("deployKey.get", () => deployKey.get().pipe(Effect.orDie))
  }),
)
