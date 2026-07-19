import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Instruction } from "@/session/instruction"
import { Provider } from "@/provider/provider"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/config"

export const PromptCatalogEntry = Schema.Struct({
  id: Schema.String,
  group: Schema.String,
  title: Schema.String,
  description: Schema.String,
  default: Schema.String,
  value: Schema.String,
  overridden: Schema.Boolean,
})

// 系统提示词条目:source 为本地绝对路径或远程 URL,content 为提示词正文
export const InstructionEntry = Schema.Struct({
  source: Schema.String,
  content: Schema.String,
}).annotate({ identifier: "InstructionEntry" })

export const ConfigApi = HttpApi.make("config")
  .add(
    HttpApiGroup.make("config")
      .add(
        HttpApiEndpoint.get("get", root, {
          query: WorkspaceRoutingQuery,
          success: described(ConfigV1.Info, "Get config info"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.get",
            summary: "Get configuration",
            description: "Retrieve the current OpenCode configuration settings and preferences.",
          }),
        ),
        HttpApiEndpoint.patch("update", root, {
          query: WorkspaceRoutingQuery,
          payload: ConfigV1.Info,
          success: described(ConfigV1.Info, "Successfully updated config"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.update",
            summary: "Update configuration",
            description: "Update OpenCode configuration settings and preferences.",
          }),
        ),
        HttpApiEndpoint.get("providers", `${root}/providers`, {
          query: WorkspaceRoutingQuery,
          success: described(Provider.ConfigProvidersResult, "List of providers"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.providers",
            summary: "List config providers",
            description: "Get a list of all configured AI providers and their default models.",
          }),
        ),
        HttpApiEndpoint.get("prompts", `${root}/prompts`, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(PromptCatalogEntry), "Prompt catalog entries"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.prompts",
            summary: "List prompt catalog",
            description: "List built-in prompts with effective values after config.prompts overrides.",
          }),
        ),
        HttpApiEndpoint.get("instructions", `${root}/instructions`, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(InstructionEntry), "Resolved instruction entries"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.instructions",
            summary: "List resolved instructions",
            description:
              "List the resolved system instruction files and remote URLs for the current instance, with their content.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "config",
          description: "Experimental HttpApi config routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
