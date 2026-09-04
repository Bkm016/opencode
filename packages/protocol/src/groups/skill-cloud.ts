import { SkillCloud } from "@opencode-ai/schema/skill-cloud"
import { optional } from "@opencode-ai/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

export class SkillCloudError extends Schema.ErrorClass<SkillCloudError>("SkillCloudError")(
  {
    name: Schema.Literal("SkillCloudError"),
    data: Schema.Struct({
      reason: SkillCloud.ErrorReason,
      message: Schema.String,
    }),
  },
  { httpApiStatus: 400 },
) {}

const root = "/api/skill/cloud"

export const SkillCloudGroup = HttpApiGroup.make("server.skillCloud")
  .add(
    HttpApiEndpoint.get("skillCloud.list", `${root}/list`, {
      success: Schema.Array(SkillCloud.Status),
      error: SkillCloudError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.skillCloud.list",
        summary: "List cloud skill repositories",
        description: "List all configured managed Git repositories used for cloud skills.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("skillCloud.status", root, {
      query: Schema.Struct({
        name: Schema.String.pipe(optional),
      }),
      success: SkillCloud.Status,
      error: SkillCloudError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.skillCloud.status",
        summary: "Get cloud skill status",
        description: "Inspect a managed Git repository used for cloud skills.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.put("skillCloud.configure", root, {
      payload: SkillCloud.ConfigureInput,
      success: SkillCloud.Status,
      error: SkillCloudError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.skillCloud.configure",
        summary: "Configure cloud skills",
        description: "Clone or repoint a managed cloud skill Git repository.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("skillCloud.update", `${root}/update`, {
      payload: SkillCloud.UpdateInput,
      success: Schema.Array(SkillCloud.Status),
      error: SkillCloudError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.skillCloud.update",
        summary: "Update cloud skills",
        description: "Fetch and fast-forward managed cloud skill repositories.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("skillCloud.sync", `${root}/sync`, {
      payload: SkillCloud.SyncInput,
      success: SkillCloud.Status,
      error: SkillCloudError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.skillCloud.sync",
        summary: "Sync cloud skills",
        description: "Commit local cloud skill changes, rebase, and push them to the configured repository.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("skillCloud.remove", `${root}/remove`, {
      payload: SkillCloud.RemoveInput,
      success: Schema.Array(SkillCloud.Status),
      error: SkillCloudError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.skillCloud.remove",
        summary: "Remove cloud skill repository",
        description: "Remove a managed cloud skill Git repository from the local environment.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "cloudSkills",
      description: "Managed cloud skill Git repository routes.",
    }),
  )
