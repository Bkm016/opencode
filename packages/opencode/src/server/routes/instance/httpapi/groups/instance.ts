import { Agent } from "@/agent/agent"
import { Command } from "@/command"
import { RunConfig, RunFile } from "@opencode-ai/schema/command"
import { Location } from "@opencode-ai/schema/location"
import { Format } from "@/format"
import { LSP } from "@/lsp/lsp"
import { Vcs } from "@/project/vcs"
import { Skill } from "@/skill"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
} from "../middleware/workspace-routing"
import { described } from "./metadata"

const DatabaseTableInfo = Schema.Struct({
  name: Schema.String,
  rows: Schema.optional(Schema.Number),
}).annotate({ identifier: "DatabaseTable" })

const DatabaseInfo = Schema.Struct({
  path: Schema.String,
  data: Schema.String,
  size: Schema.optional(Schema.Number),
  walSize: Schema.optional(Schema.Number),
  shmSize: Schema.optional(Schema.Number),
  journalMode: Schema.optional(Schema.String),
  pageCount: Schema.optional(Schema.Number),
  pageSize: Schema.optional(Schema.Number),
  freelistCount: Schema.optional(Schema.Number),
  tables: Schema.Array(DatabaseTableInfo),
}).annotate({ identifier: "DatabaseInfo" })

const PathInfo = Schema.Struct({
  home: Schema.String,
  state: Schema.String,
  config: Schema.String,
  worktree: Schema.String,
  directory: Schema.String,
  data: Schema.String,
  cache: Schema.String,
  log: Schema.String,
  database: DatabaseInfo,
}).annotate({ identifier: "Path" })

export class ApiVcsApplyError extends Schema.ErrorClass<ApiVcsApplyError>("VcsApplyError")(
  {
    name: Schema.Literal("VcsApplyError"),
    data: Schema.Struct({
      message: Schema.String,
      reason: Schema.Literals(["non-git", "not-clean"]),
    }),
  },
  { httpApiStatus: 400 },
) {}

export class ApiRunScriptError extends Schema.ErrorClass<ApiRunScriptError>("RunScriptError")(
  {
    name: Schema.Literal("RunScriptError"),
    data: Schema.Struct({
      message: Schema.String,
      path: Schema.String,
    }),
  },
  { httpApiStatus: 422 },
) {}

export const InstancePaths = {
  dispose: "/instance/dispose",
  reload: "/instance/reload",
  path: "/path",
  vcs: "/vcs",
  vcsStatus: "/vcs/status",
  vcsDiffRaw: "/vcs/diff/raw",
  vcsApply: "/vcs/apply",
  command: "/command",
  // Desktop V1 客户端请求的是完整 API 路径；不要再改回相对 Instance 路径。
  commandRun: "/api/command/run",
  agent: "/agent",
  skill: "/skill",
  lsp: "/lsp",
  formatter: "/formatter",
} as const

export const InstanceApi = HttpApi.make("instance")
  .add(
    HttpApiGroup.make("instance")
      .add(
        HttpApiEndpoint.post("dispose", InstancePaths.dispose, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Instance disposed"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "instance.dispose",
            summary: "Dispose instance",
            description: "Clean up and dispose the current OpenCode instance, releasing all resources.",
          }),
        ),
        HttpApiEndpoint.post("reload", InstancePaths.reload, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Instance reloaded"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "instance.reload",
            summary: "Reload instance",
            description:
              "Reload the current OpenCode instance so config, skills, plugins, agents, and commands are re-read from disk.",
          }),
        ),
        HttpApiEndpoint.get("path", InstancePaths.path, {
          query: WorkspaceRoutingQuery,
          success: PathInfo,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "path.get",
            summary: "Get paths",
            description:
              "Retrieve the current working directory and related path information for the OpenCode instance.",
          }),
        ),
        HttpApiEndpoint.get("vcs", InstancePaths.vcs, {
          query: WorkspaceRoutingQuery,
          success: described(Vcs.Info, "VCS info"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.get",
            summary: "Get VCS info",
            description:
              "Retrieve version control system (VCS) information for the current project, such as git branch.",
          }),
        ),
        HttpApiEndpoint.get("vcsStatus", InstancePaths.vcsStatus, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Vcs.FileStatus), "VCS status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.status",
            summary: "Get VCS status",
            description: "Retrieve changed files in the current working tree without patches.",
          }),
        ),
        HttpApiEndpoint.get("vcsDiffRaw", InstancePaths.vcsDiffRaw, {
          query: WorkspaceRoutingQuery,
          success: described(
            Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/x-diff; charset=utf-8" })),
            "Raw VCS diff",
          ),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.diff.raw",
            summary: "Get raw VCS diff",
            description: "Retrieve a raw patch for current uncommitted changes.",
          }),
        ),
        HttpApiEndpoint.post("vcsApply", InstancePaths.vcsApply, {
          query: WorkspaceRoutingQuery,
          payload: Vcs.ApplyInput,
          success: described(Vcs.ApplyResult, "VCS patch applied"),
          error: ApiVcsApplyError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.apply",
            summary: "Apply VCS patch",
            description: "Apply a raw patch to the current working tree.",
          }),
        ),
        HttpApiEndpoint.get("command", InstancePaths.command, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Command.Info), "List of commands"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "command.list",
            summary: "List commands",
            description: "Get a list of all available commands in the OpenCode system.",
          }),
        ),
        HttpApiEndpoint.get("commandGetRun", InstancePaths.commandRun, {
          query: WorkspaceRoutingQuery,
          success: described(Location.response(RunFile), "Resolve the project run script file"),
          error: ApiRunScriptError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "command.getRun",
            summary: "Get project run script file",
            description: "Resolve the authoritative .opencode/run.json path.",
          }),
        ),
        HttpApiEndpoint.put("commandUpdateRun", InstancePaths.commandRun, {
          query: WorkspaceRoutingQuery,
          payload: RunConfig,
          success: described(Location.response(RunFile), "Write project run scripts"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "command.updateRun",
            summary: "Update project run scripts",
            description: "Write the project .opencode/run.json script definitions.",
          }),
        ),
        HttpApiEndpoint.get("agent", InstancePaths.agent, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Agent.Info), "List of agents"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "app.agents",
            summary: "List agents",
            description: "Get a list of all available AI agents in the OpenCode system.",
          }),
        ),
        HttpApiEndpoint.get("skill", InstancePaths.skill, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Skill.Info), "List of skills"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "app.skills",
            summary: "List skills",
            description: "Get a list of all available skills in the OpenCode system.",
          }),
        ),
        HttpApiEndpoint.get("lsp", InstancePaths.lsp, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(LSP.Status), "LSP server status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "lsp.status",
            summary: "Get LSP status",
            description: "Get LSP server status",
          }),
        ),
        HttpApiEndpoint.get("formatter", InstancePaths.formatter, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Format.Status), "Formatter status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "formatter.status",
            summary: "Get formatter status",
            description: "Get formatter status",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "instance",
          description: "Experimental HttpApi instance read routes.",
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
