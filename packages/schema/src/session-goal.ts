export * as SessionGoal from "./session-goal"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { SessionID } from "./session-id"
import { NonNegativeInt } from "./schema"

export const GoalID = Schema.String.check(Schema.isStartsWith("goal")).pipe(Schema.brand("GoalID"))
export type GoalID = typeof GoalID.Type

export const Status = Schema.Literals(["active", "paused", "complete", "blocked", "budget_limited", "usage_limited"])
export type Status = Schema.Schema.Type<typeof Status>

export const LessonID = Schema.String.check(Schema.isStartsWith("lsn")).pipe(Schema.brand("LessonID"))
export type LessonID = typeof LessonID.Type

export const EvidenceSnapshot = Schema.Struct({
  callID: Schema.String,
  tool: Schema.String,
  excerpt: Schema.String,
}).annotate({ identifier: "GoalEvidenceSnapshot" })
export type EvidenceSnapshot = Schema.Schema.Type<typeof EvidenceSnapshot>

export const IterationPolicy = Schema.String.annotate({ identifier: "GoalIterationPolicy" })
export type IterationPolicy = Schema.Schema.Type<typeof IterationPolicy>

export const GoalInfo = Schema.Struct({
  goalID: GoalID,
  sessionID: SessionID,
  outcome: Schema.String,
  verification: Schema.Array(Schema.String),
  constraints: Schema.Array(Schema.String),
  boundaries: Schema.Array(Schema.String),
  iterationPolicy: IterationPolicy,
  blockedCondition: Schema.optional(Schema.String),
  tokenBudget: Schema.optional(NonNegativeInt),
  tokensUsed: NonNegativeInt,
  timeUsedSeconds: NonNegativeInt,
  status: Status,
  evidence: Schema.Array(EvidenceSnapshot),
  createdAt: NonNegativeInt,
  updatedAt: NonNegativeInt,
}).annotate({ identifier: "SessionGoal" })
export type GoalInfo = Schema.Schema.Type<typeof GoalInfo>

export const LessonInfo = Schema.Struct({
  id: LessonID,
  goalID: GoalID,
  attempt: Schema.String,
  observed: Schema.String,
  implication: Schema.String,
  evidence: Schema.Array(EvidenceSnapshot),
  createdAt: NonNegativeInt,
  disabledAt: Schema.optional(NonNegativeInt),
}).annotate({ identifier: "SessionGoalLesson" })
export type LessonInfo = Schema.Schema.Type<typeof LessonInfo>

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()(
  "SessionGoalNotFoundError",
  { sessionID: SessionID },
  { httpApiStatus: 404 },
) {}

export class ReplaceConflict extends Schema.TaggedErrorClass<ReplaceConflict>()(
  "SessionGoalReplaceConflict",
  { currentGoalID: GoalID },
  { httpApiStatus: 409 },
) {}

export class StaleWrite extends Schema.TaggedErrorClass<StaleWrite>()(
  "SessionGoalStaleWrite",
  { expectedGoalID: GoalID, currentGoalID: Schema.optional(GoalID) },
  { httpApiStatus: 409 },
) {}

export class InvalidEvidence extends Schema.TaggedErrorClass<InvalidEvidence>()(
  "SessionGoalInvalidEvidence",
  { detail: Schema.String },
  { httpApiStatus: 400 },
) {}

export class InvalidState extends Schema.TaggedErrorClass<InvalidState>()(
  "SessionGoalInvalidState",
  { detail: Schema.String, currentStatus: Schema.optional(Status) },
  { httpApiStatus: 400 },
) {}

const Updated = define({
  type: "session.goal.updated",
  schema: {
    sessionID: SessionID,
    goal: GoalInfo,
  },
})

const Cleared = define({
  type: "session.goal.cleared",
  schema: {
    sessionID: SessionID,
    goalID: Schema.optional(GoalID),
  },
})

const LessonUpdated = define({
  type: "session.goal.lesson.updated",
  schema: {
    sessionID: SessionID,
    goalID: GoalID,
    lesson: LessonInfo,
  },
})

const LessonDeleted = define({
  type: "session.goal.lesson.deleted",
  schema: {
    sessionID: SessionID,
    goalID: GoalID,
    lessonID: LessonID,
  },
})

export const Event = {
  Updated,
  Cleared,
  LessonUpdated,
  LessonDeleted,
  Definitions: inventory(Updated, Cleared, LessonUpdated, LessonDeleted),
}