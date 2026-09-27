import { DeployKey } from "@opencode-ai/core/deploy-key"
import { DeployKeyError } from "@opencode-ai/protocol/groups/deploy-key"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const DeployKeyHandler = HttpApiBuilder.group(Api, "server.deployKey", (handlers) =>
  Effect.gen(function* () {
    const deployKey = yield* DeployKey.Service

    return handlers.handle("deployKey.get", (ctx) =>
      deployKey.get(ctx.query.repository).pipe(
        Effect.mapError(
          (error) =>
            new DeployKeyError({
              name: "DeployKeyError",
              data: { reason: error.reason, message: error.detail },
            }),
        ),
      ),
    )
  }),
)
