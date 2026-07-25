import { Goal } from "@/session/goal"
import { SessionID } from "@/session/schema"
import { Schema, Struct } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ApiNotFoundError, InvalidRequestError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/session/:sessionID/goal"

const CreatePayload = Schema.Struct({
  ...Struct.omit(Goal.CreateInput.fields, ["sessionID"]),
  expectedGoalID: Schema.optional(Goal.GoalID),
  confirmReplace: Schema.optional(Schema.Boolean),
  agent: Schema.optional(Schema.String),
  providerID: Schema.optional(Schema.String),
  modelID: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
})

const PatchContractPayload = Schema.Struct({
  ...Goal.PatchContractInput.fields,
  expectedGoalID: Schema.optional(Goal.GoalID),
})

const PatchStatusPayload = Schema.Struct({
  ...Goal.PatchStatusInput.fields,
  expectedGoalID: Schema.optional(Goal.GoalID),
})

const AddLessonPayload = Schema.Struct({
  ...Goal.AddLessonInput.fields,
  expectedGoalID: Schema.optional(Goal.GoalID),
})

const ClearBudgetPayload = Schema.Struct({
  expectedGoalID: Goal.GoalID,
})

const PatchBudgetPayload = Schema.Struct({
  tokenBudget: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  expectedGoalID: Schema.optional(Goal.GoalID),
})

const GoalErrors = [
  ApiNotFoundError,
  InvalidRequestError,
  Goal.NotFoundError,
  Goal.ReplaceConflict,
  Goal.StaleWrite,
  Goal.InvalidEvidence,
  Goal.InvalidState,
]

export const GoalApi = HttpApi.make("goal")
  .add(
    HttpApiGroup.make("goal")
      .add(
        HttpApiEndpoint.get("get", root, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.NullOr(Goal.Info), "Active goal for the session, or null"),
          error: GoalErrors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "goal.get",
            summary: "Get active goal",
            description: "Get the active goal for a session, or null if none exists.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.post("create", root, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: CreatePayload,
          success: described(Goal.Info, "Created goal"),
          error: GoalErrors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "goal.create",
            summary: "Create or replace goal",
            description: "Create a new goal for the session. If an active goal exists, a confirmReplace flag or expectedGoalID is required to replace it. Completed or blocked goals are replaced unconditionally. After creation, triggers goal continuation with optional agent/provider/model overrides.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.delete("clear", root, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Goal cleared"),
          error: GoalErrors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "goal.clear",
            summary: "Clear goal",
            description: "Clear the active goal for a session.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.patch("patchContract", `${root}/contract`, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: PatchContractPayload,
          success: described(Goal.Info, "Updated goal"),
          error: GoalErrors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "goal.patchContract",
            summary: "Patch goal contract",
            description: "Patch the outcome, verification, constraints, boundaries, or iteration policy of the active goal.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.patch("patchStatus", `${root}/status`, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: PatchStatusPayload,
          success: described(Goal.Info, "Updated goal"),
          error: GoalErrors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "goal.patchStatus",
            summary: "Patch goal status",
            description: "Mark the active goal as complete or blocked.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.patch("patchBudget", `${root}/budget`, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: PatchBudgetPayload,
          success: described(Goal.Info, "Updated goal"),
          error: GoalErrors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "goal.patchBudget",
            summary: "Patch goal budget",
            description: "Set or clear the token budget for the goal. Pass null to clear the budget. A positive integer sets the budget. Only goals in active or budget_limited status are affected.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.post("clearBudget", `${root}/budget/clear`, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: ClearBudgetPayload,
          success: described(Goal.Info, "Updated goal"),
          error: GoalErrors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "goal.clearBudget",
            summary: "Clear goal budget",
            description: "Remove the token budget from an active or budget-limited goal.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.post("pause", `${root}/pause`, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Goal.Info, "Paused goal"),
          error: GoalErrors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "goal.pause",
            summary: "Pause goal",
            description: "Pause the active goal, preventing auto-continuation. Returns 404 if no goal exists.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.post("resume", `${root}/resume`, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Goal.Info, "Resumed goal"),
          error: GoalErrors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "goal.resume",
            summary: "Resume goal",
            description: "Resume a paused/blocked/usage_limited goal to active. budget_limited requires raising/clearing the budget first.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.post("wake", `${root}/wake`, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Goal.Info, "Woken goal"),
          error: GoalErrors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "goal.wake",
            summary: "Wake goal",
            description: "Trigger continuation for an active goal. Does not resume paused goals.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.post("addLesson", `${root}/lesson`, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: AddLessonPayload,
          success: described(Goal.Lesson, "Added lesson"),
          error: GoalErrors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "goal.addLesson",
            summary: "Add lesson to goal",
            description: "Add a lesson learned during the active goal.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.post("disableLesson", `${root}/lesson/:lessonID/disable`, {
          params: { sessionID: SessionID, lessonID: Goal.LessonID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Lesson disabled"),
          error: GoalErrors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "goal.disableLesson",
            summary: "Disable lesson",
            description: "Disable a lesson so it is no longer injected into goal continuations.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.delete("deleteLesson", `${root}/lesson/:lessonID`, {
          params: { sessionID: SessionID, lessonID: Goal.LessonID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Lesson deleted"),
          error: GoalErrors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "goal.deleteLesson",
            summary: "Delete lesson",
            description: "Delete a lesson from the active goal.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.get("lessons", `${root}/lessons`, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Goal.Lesson), "Lessons for the active goal"),
          error: GoalErrors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "goal.lessons",
            summary: "List lessons",
            description: "List all lessons for the active goal.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "goal",
          description: "Goal routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode HttpApi",
      version: "0.0.1",
      description: "Effect HttpApi surface for instance routes.",
    }),
  )
