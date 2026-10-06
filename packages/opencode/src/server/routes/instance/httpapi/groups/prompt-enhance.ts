import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

export const EnhancePayload = Schema.Struct({
  text: Schema.String,
  sessionID: Schema.optional(Schema.String),
  model: Schema.optional(Schema.Struct({ providerID: Schema.String, modelID: Schema.String })),
})

export const PromptEnhanceApi = HttpApi.make("promptEnhance").add(
  HttpApiGroup.make("promptEnhance")
    .add(
      HttpApiEndpoint.post("enhance", "/experimental/prompt/enhance", {
        query: WorkspaceRoutingQuery,
        payload: EnhancePayload,
        success: described(Schema.String, "Rewritten prompt, streamed as plain text"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.prompt.enhance",
          summary: "Enhance prompt",
          description:
            "Rewrite a draft prompt so it is clearer, using the session's recent conversation to resolve references. Streams plain text.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "promptEnhance", description: "Prompt rewriting routes." }))
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
