import { DeployKey } from "@opencode-ai/schema/deploy-key"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

export class DeployKeyError extends Schema.ErrorClass<DeployKeyError>("DeployKeyError")(
  {
    name: Schema.Literal("DeployKeyError"),
    data: Schema.Struct({
      reason: DeployKey.ErrorReason,
      message: Schema.String,
    }),
  },
  { httpApiStatus: 400 },
) {}

export const DeployKeyGroup = HttpApiGroup.make("server.deployKey").add(
  HttpApiEndpoint.get("deployKey.get", "/api/deploy-key", {
    query: DeployKey.GetInput,
    success: DeployKey.Info,
    error: DeployKeyError,
  }).annotateMerge(
    OpenApi.annotations({
      identifier: "v2.deployKey.get",
      summary: "Get deploy key",
      description:
        "Get the public half and managed file locations of the SSH deploy key dedicated to one remote repository, generating it when needed.",
    }),
  ),
)
