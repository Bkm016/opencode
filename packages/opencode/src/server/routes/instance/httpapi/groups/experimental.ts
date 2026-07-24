import { AccountID, OrgID } from "@/account/schema"
import { MCP } from "@/mcp"

import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Worktree } from "@/worktree"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"
import { QueryBoolean } from "./query"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const ConsoleStateResponse = Schema.Struct({
  consoleManagedProviders: Schema.mutable(Schema.Array(Schema.String)),
  activeOrgName: Schema.optionalKey(Schema.String),
  switchableOrgCount: NonNegativeInt,
}).annotate({ identifier: "ConsoleState" })

const CapabilitiesResponse = Schema.Struct({
  backgroundSubagents: Schema.Boolean,
}).annotate({ identifier: "ExperimentalCapabilities" })

const ConsoleOrgOption = Schema.Struct({
  accountID: Schema.String,
  accountEmail: Schema.String,
  accountUrl: Schema.String,
  orgID: Schema.String,
  orgName: Schema.String,
  active: Schema.Boolean,
})

const ConsoleOrgList = Schema.Struct({
  orgs: Schema.Array(ConsoleOrgOption),
})

export const ConsoleSwitchPayload = Schema.Struct({
  accountID: AccountID,
  orgID: OrgID,
})

const ToolIDs = Schema.Array(Schema.String).annotate({ identifier: "ToolIDs" })
const ToolListItem = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  parameters: Schema.Unknown,
}).annotate({ identifier: "ToolListItem" })
const ToolList = Schema.Array(ToolListItem).annotate({ identifier: "ToolList" })
const SystemPromptPreview = Schema.Array(Schema.String).annotate({ identifier: "SystemPromptPreview" })
export const ToolListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  provider: ProviderV2.ID,
  model: ModelV2.ID,
})

const WorktreeList = Schema.Array(Schema.String)
const WorktreeErrorName = Schema.Union([
  Schema.Literal("WorktreeNotGitError"),
  Schema.Literal("WorktreeNameGenerationFailedError"),
  Schema.Literal("WorktreeCreateFailedError"),
  Schema.Literal("WorktreeStartCommandFailedError"),
  Schema.Literal("WorktreeRemoveFailedError"),
  Schema.Literal("WorktreeResetFailedError"),
  Schema.Literal("WorktreeListFailedError"),
])
export class WorktreeApiError extends Schema.ErrorClass<WorktreeApiError>("WorktreeError")(
  {
    name: WorktreeErrorName,
    data: Schema.Struct({ message: Schema.String }),
  },
  { httpApiStatus: 400 },
) {}
export const SessionListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  roots: Schema.optional(QueryBoolean),
  start: Schema.optional(Schema.NumberFromString),
  cursor: Schema.optional(Schema.NumberFromString),
  search: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
  archived: Schema.optional(QueryBoolean),
})

const StorageFileStats = Schema.Struct({
  path: Schema.String,
  bytes: Schema.Number,
  files: Schema.Number,
  expiredBytes: Schema.Number,
  expiredFiles: Schema.Number,
}).annotate({ identifier: "StorageFileStats" })

const StorageDatabaseStats = Schema.Struct({
  path: Schema.String,
  size: Schema.optional(Schema.Number),
  walSize: Schema.optional(Schema.Number),
  shmSize: Schema.optional(Schema.Number),
  pageCount: Schema.optional(Schema.Number),
  pageSize: Schema.optional(Schema.Number),
  freelistCount: Schema.optional(Schema.Number),
  reclaimableBytes: Schema.optional(Schema.Number),
}).annotate({ identifier: "StorageDatabaseStats" })

const StorageEntry = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  kind: Schema.Literals(["file", "directory"]),
  bytes: Schema.Number,
}).annotate({ identifier: "StorageEntry" })

const StorageTableStats = Schema.Struct({
  name: Schema.String,
  rows: Schema.optional(Schema.Number),
}).annotate({ identifier: "StorageTableStats" })

const StorageSessionStats = Schema.Struct({
  retentionDays: Schema.Number,
  unloadedProjects: Schema.Literals(["available", "unavailable"]),
  candidates: Schema.Number,
  blocked: Schema.Number,
}).annotate({ identifier: "StorageSessionStats" })

export const StorageBudget = Schema.Struct({
  database: StorageDatabaseStats,
  toolOutput: StorageFileStats,
  logs: StorageFileStats,
  sessions: StorageSessionStats,
  retentionDays: Schema.Number,
  dataRoot: Schema.String,
  dataBytes: Schema.Number,
  entries: Schema.Array(StorageEntry),
  tables: Schema.Array(StorageTableStats),
}).annotate({ identifier: "StorageBudget" })

// App 侧当前打开的 project worktree 目录；用于规则 A，不能依赖 InstanceStore.listLoaded。
export const StorageBudgetQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  openProjectDirectories: Schema.optional(Schema.Array(Schema.String)),
})

export const StorageCompactPayload = Schema.Struct({
  checkpoint: Schema.optional(Schema.Boolean),
  vacuum: Schema.optional(Schema.Boolean),
  toolOutput: Schema.optional(Schema.Boolean),
  logs: Schema.optional(Schema.Boolean),
  sessions: Schema.optional(Schema.Boolean),
  retentionDays: Schema.optional(Schema.Number),
  openProjectDirectories: Schema.optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "StorageCompactPayload" })

const StorageCompactResult = Schema.Struct({
  checkpoint: Schema.optional(Schema.Boolean),
  vacuum: Schema.optional(Schema.Boolean),
  toolOutputRemoved: Schema.optional(Schema.Number),
  toolOutputBytes: Schema.optional(Schema.Number),
  logsRemoved: Schema.optional(Schema.Number),
  logsBytes: Schema.optional(Schema.Number),
  sessionsRemoved: Schema.optional(Schema.Number),
  before: StorageBudget,
  after: StorageBudget,
  durationMs: Schema.Number,
}).annotate({ identifier: "StorageCompactResult" })

export const ExperimentalPaths = {
  capabilities: "/experimental/capabilities",
  console: "/experimental/console",
  consoleOrgs: "/experimental/console/orgs",
  consoleSwitch: "/experimental/console/switch",
  tool: "/experimental/tool",
  toolIDs: "/experimental/tool/ids",
  worktree: "/experimental/worktree",
  worktreeReset: "/experimental/worktree/reset",
  session: "/experimental/session",
  sessionSystemPrompt: "/experimental/session/:sessionID/system-prompt",
  sessionBackground: "/experimental/session/:sessionID/background",
  resource: "/experimental/resource",
  storage: "/experimental/storage",
  storageCompact: "/experimental/storage/compact",
} as const

export const ExperimentalApi = HttpApi.make("experimental")
  .add(
    HttpApiGroup.make("experimental")
      .add(
        HttpApiEndpoint.get("capabilities", ExperimentalPaths.capabilities, {
          query: WorkspaceRoutingQuery,
          success: described(CapabilitiesResponse, "Experimental capabilities"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.capabilities.get",
            summary: "Get experimental capabilities",
            description: "Get experimental features enabled on the OpenCode server.",
          }),
        ),
        HttpApiEndpoint.get("console", ExperimentalPaths.console, {
          query: WorkspaceRoutingQuery,
          success: described(ConsoleStateResponse, "Active Console provider metadata"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.get",
            summary: "Get active Console provider metadata",
            description: "Get the active Console org name and the set of provider IDs managed by that Console org.",
          }),
        ),
        HttpApiEndpoint.get("consoleOrgs", ExperimentalPaths.consoleOrgs, {
          query: WorkspaceRoutingQuery,
          success: described(ConsoleOrgList, "Switchable Console orgs"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.listOrgs",
            summary: "List switchable Console orgs",
            description: "Get the available Console orgs across logged-in accounts, including the current active org.",
          }),
        ),
        HttpApiEndpoint.post("consoleSwitch", ExperimentalPaths.consoleSwitch, {
          query: WorkspaceRoutingQuery,
          payload: ConsoleSwitchPayload,
          success: described(Schema.Boolean, "Switch success"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.switchOrg",
            summary: "Switch active Console org",
            description: "Persist a new active Console account/org selection for the current local OpenCode state.",
          }),
        ),
        HttpApiEndpoint.get("tool", ExperimentalPaths.tool, {
          query: ToolListQuery,
          success: described(ToolList, "Tools"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tool.list",
            summary: "List tools",
            description:
              "Get a list of available tools with their JSON schema parameters for a specific provider and model combination.",
          }),
        ),
        HttpApiEndpoint.get("toolIDs", ExperimentalPaths.toolIDs, {
          query: WorkspaceRoutingQuery,
          success: described(ToolIDs, "Tool IDs"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tool.ids",
            summary: "List tool IDs",
            description:
              "Get a list of all available tool IDs, including both built-in tools and dynamically registered tools.",
          }),
        ),
        HttpApiEndpoint.get("worktree", ExperimentalPaths.worktree, {
          query: WorkspaceRoutingQuery,
          success: described(WorktreeList, "List of worktree directories"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.list",
            summary: "List worktrees",
            description: "List all sandbox worktrees for the current project.",
          }),
        ),
        HttpApiEndpoint.post("worktreeCreate", ExperimentalPaths.worktree, {
          disableCodecs: true,
          query: WorkspaceRoutingQuery,
          payload: [HttpApiSchema.NoContent, Worktree.CreateInput],
          success: described(Worktree.Info, "Worktree created"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.create",
            summary: "Create worktree",
            description: "Create a new git worktree for the current project and run any configured startup scripts.",
          }),
        ),
        HttpApiEndpoint.delete("worktreeRemove", ExperimentalPaths.worktree, {
          query: WorkspaceRoutingQuery,
          payload: Worktree.RemoveInput,
          success: described(Schema.Boolean, "Worktree removed"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.remove",
            summary: "Remove worktree",
            description: "Remove a git worktree and delete its branch.",
          }),
        ),
        HttpApiEndpoint.post("worktreeReset", ExperimentalPaths.worktreeReset, {
          query: WorkspaceRoutingQuery,
          payload: Worktree.ResetInput,
          success: described(Schema.Boolean, "Worktree reset"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.reset",
            summary: "Reset worktree",
            description: "Reset a worktree branch to the primary default branch.",
          }),
        ),
        HttpApiEndpoint.get("session", ExperimentalPaths.session, {
          query: SessionListQuery,
          success: described(Schema.Array(Session.GlobalInfo), "List of sessions"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.list",
            summary: "List sessions",
            description:
              "Get a list of all OpenCode sessions across projects, sorted by most recently updated. Archived sessions are excluded by default.",
          }),
        ),
        HttpApiEndpoint.post("sessionBackground", ExperimentalPaths.sessionBackground, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Backgrounded subagents"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.background",
            summary: "Background subagents",
            description:
              "Detach any synchronous subagents currently blocking the session and continue them in the background.",
          }),
        ),
        HttpApiEndpoint.get("sessionSystemPrompt", ExperimentalPaths.sessionSystemPrompt, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(SystemPromptPreview, "System prompt preview"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.systemPrompt",
            summary: "Preview system prompt",
            description:
              "Dynamically build the current system prompt for a session without creating messages or invoking a model.",
          }),
        ),
        HttpApiEndpoint.get("resource", ExperimentalPaths.resource, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Record(Schema.String, MCP.Resource), "MCP resources"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.resource.list",
            summary: "Get MCP resources",
            description: "Get all available MCP resources from connected servers. Optionally filter by name.",
          }),
        ),
        HttpApiEndpoint.get("storage", ExperimentalPaths.storage, {
          query: StorageBudgetQuery,
          success: described(StorageBudget, "Local storage budget"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.storage.get",
            summary: "Get local storage budget",
            description:
              "Report SQLite size, reclaimable freelist space, expired tool-output / log files, and optional session cleanup candidates. Pass openProjectDirectories so rule A can exclude currently open projects.",
          }),
        ),
        HttpApiEndpoint.post("storageCompact", ExperimentalPaths.storageCompact, {
          query: WorkspaceRoutingQuery,
          payload: StorageCompactPayload,
          success: described(StorageCompactResult, "Storage compact result"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.storage.compact",
            summary: "Compact local storage",
            description:
              "Safely reclaim disk space: optional session cleanup via Session.remove, WAL checkpoint, VACUUM freelist pages, and delete expired tool-output / log files. Pass openProjectDirectories for session rule A. Does not delete credentials.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "experimental",
          description: "Experimental HttpApi read-only routes.",
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
