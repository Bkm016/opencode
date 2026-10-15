import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

export const SuggestPayload = Schema.Struct({
  model: Schema.optional(Schema.Struct({ providerID: Schema.String, modelID: Schema.String })),
})

export const SuggestResult = Schema.Struct({
  text: Schema.optional(Schema.String),
})

export const PromptSuggestApi = HttpApi.make("promptSuggest").add(
  HttpApiGroup.make("promptSuggest")
    .add(
      HttpApiEndpoint.post("suggest", "/session/:sessionID/suggestion", {
        params: { sessionID: Schema.String },
        query: WorkspaceRoutingQuery,
        payload: SuggestPayload,
        success: described(SuggestResult, "Suggested next user message, absent when there is no obvious next step"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.prompt.suggest",
          summary: "Suggest next message",
          description:
            "Predict the user's most likely next message from the session's recent conversation, to prefill the empty prompt input.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "promptSuggest", description: "Next-message suggestion routes." }))
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
