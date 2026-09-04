import { SkillCloud } from "@opencode-ai/core/skill-cloud"
import { SkillCloudError } from "@opencode-ai/protocol/groups/skill-cloud"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const SkillCloudHandler = HttpApiBuilder.group(Api, "server.skillCloud", (handlers) =>
  Effect.gen(function* () {
    const cloud = yield* SkillCloud.Service
    const response = <A>(effect: Effect.Effect<A, SkillCloud.OperationError>) =>
      effect.pipe(
        Effect.mapError(
          (error) =>
            new SkillCloudError({
              name: "SkillCloudError",
              data: { reason: error.reason, message: error.detail },
            }),
        ),
      )

    return handlers
      .handle("skillCloud.list", () => response(cloud.list()))
      .handle("skillCloud.status", (ctx) => response(cloud.status(ctx.query.name)))
      .handle("skillCloud.configure", (ctx) => response(cloud.configure(ctx.payload)))
      .handle("skillCloud.update", (ctx) => response(cloud.update(ctx.payload)))
      .handle("skillCloud.sync", (ctx) => response(cloud.sync(ctx.payload)))
      .handle("skillCloud.remove", (ctx) => response(cloud.remove(ctx.payload)))
  }),
)
