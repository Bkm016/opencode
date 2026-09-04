import { DeployKey } from "@opencode-ai/schema/deploy-key"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

export const DeployKeyGroup = HttpApiGroup.make("server.deployKey").add(
  HttpApiEndpoint.get("deployKey.get", "/api/deploy-key", {
    success: DeployKey.Info,
  }).annotateMerge(
    OpenApi.annotations({
      identifier: "v2.deployKey.get",
      summary: "Get deploy key",
      description: "Get the public half and managed file locations of the server-wide SSH deploy key.",
    }),
  ),
)
