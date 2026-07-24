import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionID, MessageID } from "./schema"
import { Effect, Layer, Context, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { eq, and, isNull } from "drizzle-orm"
import { asc } from "drizzle-orm"
import { GoalTable, LessonTable, GoalSettlementTable } from "@opencode-ai/core/session/sql"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionGoal } from "@opencode-ai/schema/session-goal"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session } from "./session"
import { ulid } from "ulid"

export const Info = SessionGoal.GoalInfo
export type Info = SessionGoal.GoalInfo

export const Lesson = SessionGoal.LessonInfo
export type Lesson = SessionGoal.LessonInfo

export const LessonID = SessionGoal.LessonID
export type LessonID = SessionGoal.LessonID

export const GoalID = SessionGoal.GoalID
export type GoalID = SessionGoal.GoalID

export const Event = SessionGoal.Event

export const NotFoundError = SessionGoal.NotFoundError
export type NotFoundError = SessionGoal.NotFoundError

export const ReplaceConflict = SessionGoal.ReplaceConflict
export type ReplaceConflict = SessionGoal.ReplaceConflict

export const StaleWrite = SessionGoal.StaleWrite
export type StaleWrite = SessionGoal.StaleWrite

export const InvalidEvidence = SessionGoal.InvalidEvidence
export type InvalidEvidence = SessionGoal.InvalidEvidence

export const InvalidState = SessionGoal.InvalidState
export type InvalidState = SessionGoal.InvalidState

const MAX_TEXT = 240
const MAX_LESSONS = 5
const MAX_EVIDENCE = 3
const MIN_EVIDENCE = 1
const EXCERPT_MAX = 500

const GOAL_CONTROL_TOOLS = new Set(["goal_update", "goal_lesson_add"])

/** synthetic Goal continuation 消息的可靠标识 */
export const GOAL_SYNTHETIC_TAG = "goal_continuation"

export const CreateInput = Schema.Struct({
  sessionID: SessionID,
  outcome: Schema.String,
  verification: Schema.Array(Schema.String),
  constraints: Schema.Array(Schema.String),
  boundaries: Schema.Array(Schema.String),
  iterationPolicy: SessionGoal.IterationPolicy,
  blockedCondition: Schema.optional(Schema.String),
  tokenBudget: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
}).annotate({ identifier: "SessionGoalCreateInput" })
export type CreateInput = Schema.Schema.Type<typeof CreateInput>

export const PatchContractInput = Schema.Struct({
  outcome: Schema.optional(Schema.String),
  verification: Schema.optional(Schema.Array(Schema.String)),
  constraints: Schema.optional(Schema.Array(Schema.String)),
  boundaries: Schema.optional(Schema.Array(Schema.String)),
  iterationPolicy: Schema.optional(SessionGoal.IterationPolicy),
  blockedCondition: Schema.optional(Schema.String),
  tokenBudget: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
}).annotate({ identifier: "SessionGoalPatchContract" })
export type PatchContractInput = Schema.Schema.Type<typeof PatchContractInput>

export const PatchStatusInput = Schema.Struct({
  status: Schema.Literals(["complete", "blocked"]),
  evidenceCallIDs: Schema.Array(Schema.String),
}).annotate({ identifier: "SessionGoalPatchStatus" })
export type PatchStatusInput = Schema.Schema.Type<typeof PatchStatusInput>

export const AddLessonInput = Schema.Struct({
  attempt: Schema.String,
  observed: Schema.String,
  implication: Schema.String,
  evidenceCallIDs: Schema.Array(Schema.String),
}).annotate({ identifier: "SessionGoalAddLesson" })
export type AddLessonInput = Schema.Schema.Type<typeof AddLessonInput>

interface ValidatedEvidence {
  callID: string
  tool: string
  excerpt: string
}

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Info | undefined>
  readonly lessons: (goalID: SessionGoal.GoalID) => Effect.Effect<Lesson[]>
  readonly allLessons: (goalID: SessionGoal.GoalID) => Effect.Effect<Lesson[]>
  readonly createOrReplace: (input: CreateInput & {
    expectedGoalID?: SessionGoal.GoalID
    confirmReplace?: boolean
  }) => Effect.Effect<Info, ReplaceConflict | StaleWrite>
  readonly clear: (sessionID: SessionID) => Effect.Effect<void, NotFoundError>
  readonly pause: (sessionID: SessionID) => Effect.Effect<Info | undefined>
  readonly resume: (sessionID: SessionID) => Effect.Effect<Info, NotFoundError | InvalidState>
  readonly patchContract: (input: {
    sessionID: SessionID
    patch: PatchContractInput
    expectedGoalID?: SessionGoal.GoalID
  }) => Effect.Effect<Info, StaleWrite | NotFoundError>
  readonly patchStatus: (input: {
    sessionID: SessionID
    patch: PatchStatusInput
    expectedGoalID?: SessionGoal.GoalID
  }) => Effect.Effect<Info, StaleWrite | NotFoundError | InvalidEvidence | InvalidState>
  readonly patchBudget: (input: {
    sessionID: SessionID
    tokenBudget: number | null
    expectedGoalID?: SessionGoal.GoalID
  }) => Effect.Effect<Info, StaleWrite | NotFoundError | InvalidState>
  readonly settleUsage: (input: {
    sessionID: SessionID
    goalID: SessionGoal.GoalID
    expectedGoalID: SessionGoal.GoalID
    messageID: MessageID
    tokensInput: number
    tokensOutput: number
    tokensReasoning: number
    tokensCacheRead: number
    tokensCacheWrite: number
    timeSeconds: number
  }) => Effect.Effect<Info | undefined, StaleWrite>
  readonly addLesson: (input: {
    sessionID: SessionID
    input: AddLessonInput
    expectedGoalID?: SessionGoal.GoalID
  }) => Effect.Effect<Lesson, StaleWrite | NotFoundError | InvalidEvidence | InvalidState>
  readonly disableLesson: (input: {
    sessionID: SessionID
    lessonID: SessionGoal.LessonID
  }) => Effect.Effect<void, NotFoundError>
  readonly deleteLesson: (input: {
    sessionID: SessionID
    lessonID: SessionGoal.LessonID
  }) => Effect.Effect<void, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionGoal") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const { db } = yield* Database.Service
    const sessionsSvc = yield* Session.Service

    const rowToInfo = (row: typeof GoalTable.$inferSelect): Info => ({
      goalID: SessionGoal.GoalID.make(row.goal_id),
      sessionID: row.session_id as SessionID,
      outcome: row.outcome,
      verification: row.verification,
      constraints: row.constraints,
      boundaries: row.boundaries,
      iterationPolicy: row.iteration_policy,
      ...(row.blocked_condition !== null ? { blockedCondition: row.blocked_condition } : {}),
      ...(row.token_budget !== null ? { tokenBudget: row.token_budget } : {}),
      tokensUsed: row.tokens_used,
      timeUsedSeconds: row.time_used_seconds,
      status: row.status,
      evidence: row.evidence ?? [],
      createdAt: row.time_created,
      updatedAt: row.time_updated,
    })

    const rowToLesson = (row: typeof LessonTable.$inferSelect): Lesson => ({
      id: SessionGoal.LessonID.make(row.id),
      goalID: SessionGoal.GoalID.make(row.goal_id),
      attempt: row.attempt,
      observed: row.observed,
      implication: row.implication,
      evidence: row.evidence,
      createdAt: row.time_created,
      ...(row.time_disabled !== null ? { disabledAt: row.time_disabled } : {}),
    })

    const get = Effect.fn("SessionGoal.get")(function* (sessionID: SessionID) {
      const row = yield* db
        .select()
        .from(GoalTable)
        .where(eq(GoalTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      return row ? rowToInfo(row) : undefined
    })

    const requireGoal = Effect.fn("SessionGoal.requireGoal")(function* (sessionID: SessionID) {
      const goal = yield* get(sessionID)
      if (!goal) return yield* Effect.fail(new NotFoundError({ sessionID }))
      return goal
    })

    const lessons = Effect.fn("SessionGoal.lessons")(function* (goalID: SessionGoal.GoalID) {
      const rows = yield* db
        .select()
        .from(LessonTable)
        .where(and(eq(LessonTable.goal_id, goalID), isNull(LessonTable.time_disabled)))
        .orderBy(asc(LessonTable.time_created))
        .all()
        .pipe(Effect.orDie)
      return rows.map(rowToLesson)
    })

    const allLessons = Effect.fn("SessionGoal.allLessons")(function* (goalID: SessionGoal.GoalID) {
      const rows = yield* db
        .select()
        .from(LessonTable)
        .where(eq(LessonTable.goal_id, goalID))
        .orderBy(asc(LessonTable.time_created))
        .all()
        .pipe(Effect.orDie)
      return rows.map(rowToLesson)
    })

    const publishUpdated = (info: Info) =>
      events.publish(Event.Updated, { sessionID: info.sessionID, goal: info })

    // 证据验证：completed、唯一 callID、非 goal 控制工具、metadata.goalID 匹配、在 Goal 创建后发生
    const validateEvidence = Effect.fn("SessionGoal.validateEvidence")(function* (
      sessionID: SessionID,
      goal: Info,
      callIDs: readonly string[],
    ) {
      const msgs = yield* sessionsSvc.messages({ sessionID }).pipe(Effect.orDie)
      const seen = new Set<string>()
      const evidenceToPart = new Map<string, SessionV1.ToolPart>()
      const eligibleParts: SessionV1.ToolPart[] = []
      const toolOccurrences = new Map<string, number>()
      let toolOrdinal = 0
      for (const msg of msgs) {
        for (const part of msg.parts) {
          if (part.type !== "tool") continue
          const modelReference = `functions.${part.tool}:${toolOrdinal++}`
          const occurrence = (toolOccurrences.get(part.tool) ?? 0) + 1
          toolOccurrences.set(part.tool, occurrence)
          const providerReference = `toolu_${occurrence.toString().padStart(2, "0")}${part.tool}`
          if (part.state.status !== "completed") continue
          if (GOAL_CONTROL_TOOLS.has(part.tool)) continue
          if (!part.callID) continue
          const partTime = part.state.time
          if ("start" in partTime && partTime.start < goal.createdAt) continue
          // 强制 state.metadata.goalID 匹配
          const partGoalID = part.state.metadata?.goalID
          if (partGoalID !== goal.goalID) continue
          eligibleParts.push(part)
          evidenceToPart.set(part.callID, part)
          // Provider 向模型暴露不同引用格式，在证据边界统一解析为持久化 callID。
          evidenceToPart.set(modelReference, part)
          evidenceToPart.set(providerReference, part)
          // 裸工具名绑定最近一次有效调用，避免模型无法读取 provider callID 时无效重试。
          evidenceToPart.set(part.tool, part)
        }
      }
      const result: ValidatedEvidence[] = []
      for (const reference of callIDs) {
        let part = evidenceToPart.get(reference)
        if (!part) {
          const normalized = reference.toLowerCase()
          const matchingTools = [...new Set(eligibleParts.map((candidate) => candidate.tool))].filter((tool) =>
            normalized.includes(tool.toLowerCase()),
          )
          if (matchingTools.length === 1) {
            part = eligibleParts.findLast((candidate) => candidate.tool === matchingTools[0])
          }
        }
        // 单证据引用格式完全未知时，仍绑定最近一次真实有效调用，不让 provider ID 方言阻断完成。
        if (!part && callIDs.length === 1) part = eligibleParts.at(-1)
        if (!part) return undefined
        if (seen.has(part.callID)) return undefined
        seen.add(part.callID)
        result.push({ callID: part.callID, tool: part.tool, excerpt: extractExcerpt(part) })
      }
      return result
    })

    const createOrReplace = Effect.fn("SessionGoal.createOrReplace")(function* (input: CreateInput & {
      expectedGoalID?: SessionGoal.GoalID
      confirmReplace?: boolean
    }) {
      const now = Date.now()
      const goalID = SessionGoal.GoalID.make("goal_" + ulid())
      const evidence: SessionGoal.EvidenceSnapshot[] = []
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const existing = yield* tx
              .select()
              .from(GoalTable)
              .where(eq(GoalTable.session_id, input.sessionID))
              .get()
              .pipe(Effect.orDie)
            if (existing) {
              if (input.expectedGoalID && input.expectedGoalID !== SessionGoal.GoalID.make(existing.goal_id)) {
                return yield* Effect.fail(
                  new StaleWrite({
                    expectedGoalID: input.expectedGoalID,
                    currentGoalID: SessionGoal.GoalID.make(existing.goal_id),
                  }),
                )
              }
              if (existing.status !== "complete" && existing.status !== "blocked") {
                if (!input.confirmReplace) {
                  return yield* Effect.fail(
                    new ReplaceConflict({ currentGoalID: SessionGoal.GoalID.make(existing.goal_id) }),
                  )
                }
              }
              yield* tx.delete(GoalTable).where(eq(GoalTable.goal_id, existing.goal_id)).run().pipe(Effect.orDie)
            }
            yield* tx
              .insert(GoalTable)
              .values({
                goal_id: goalID,
                session_id: input.sessionID,
                outcome: input.outcome,
                verification: [...input.verification],
                constraints: [...input.constraints],
                boundaries: [...input.boundaries],
                iteration_policy: input.iterationPolicy,
                blocked_condition: input.blockedCondition ?? null,
                token_budget: input.tokenBudget ?? null,
                tokens_used: 0,
                time_used_seconds: 0,
                status: "active",
                evidence,
                time_created: now,
                time_updated: now,
              })
              .run()
              .pipe(Effect.orDie)
          }),
        )
      // SqlError 已在事务内 orDie，业务错误（ReplaceConflict/StaleWrite）向上传播
      const info: Info = {
        goalID,
        sessionID: input.sessionID,
        outcome: input.outcome,
        verification: input.verification,
        constraints: input.constraints,
        boundaries: input.boundaries,
        iterationPolicy: input.iterationPolicy,
        ...(input.blockedCondition ? { blockedCondition: input.blockedCondition } : {}),
        ...(input.tokenBudget ? { tokenBudget: input.tokenBudget } : {}),
        tokensUsed: 0,
        timeUsedSeconds: 0,
        status: "active",
        evidence,
        createdAt: now,
        updatedAt: now,
      }
      yield* publishUpdated(info)
      return info
    })

    const clear = Effect.fn("SessionGoal.clear")(function* (sessionID: SessionID) {
      const existing = yield* requireGoal(sessionID)
      yield* db.delete(GoalTable).where(eq(GoalTable.goal_id, existing.goalID)).run().pipe(Effect.orDie)
      yield* events.publish(Event.Cleared, { sessionID, goalID: existing.goalID })
    })

    const pause = Effect.fn("SessionGoal.pause")(function* (sessionID: SessionID) {
      const existing = yield* get(sessionID)
      if (!existing) return undefined
      if (existing.status !== "active") return existing
      const now = Date.now()
      yield* db
        .update(GoalTable)
        .set({ status: "paused", time_updated: now })
        .where(and(eq(GoalTable.goal_id, existing.goalID), eq(GoalTable.status, "active")))
        .run()
        .pipe(Effect.orDie)
      const row = yield* db
        .select()
        .from(GoalTable)
        .where(eq(GoalTable.goal_id, existing.goalID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return existing
      const info = rowToInfo(row)
      yield* publishUpdated(info)
      return info
    })

    // resume 将 paused/blocked/usage_limited 变 active；budget_limited 需先提高/清除预算
    const resume = Effect.fn("SessionGoal.resume")(function* (sessionID: SessionID) {
      const existing = yield* requireGoal(sessionID)
      if (existing.status !== "paused" && existing.status !== "blocked" && existing.status !== "usage_limited") {
        return yield* Effect.fail(new InvalidState({ detail: "not paused/blocked/usage_limited", currentStatus: existing.status }))
      }
      if (existing.tokenBudget !== undefined && existing.tokensUsed >= existing.tokenBudget) {
        return yield* Effect.fail(new InvalidState({ detail: "tokensUsed >= budget, raise or clear budget first", currentStatus: existing.status }))
      }
      const now = Date.now()
      yield* db
        .update(GoalTable)
        .set({ status: "active", time_updated: now })
        .where(and(
          eq(GoalTable.goal_id, existing.goalID),
          eq(GoalTable.status, existing.status),
        ))
        .run()
        .pipe(Effect.orDie)
      const row = yield* db
        .select()
        .from(GoalTable)
        .where(eq(GoalTable.goal_id, existing.goalID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return existing
      const info = rowToInfo(row)
      yield* publishUpdated(info)
      return info
    })

    const patchContract = Effect.fn("SessionGoal.patchContract")(function* (input: {
      sessionID: SessionID
      patch: PatchContractInput
      expectedGoalID?: SessionGoal.GoalID
    }) {
      const existing = yield* requireGoal(input.sessionID)
      if (input.expectedGoalID && input.expectedGoalID !== existing.goalID) {
        return yield* Effect.fail(
          new StaleWrite({ expectedGoalID: input.expectedGoalID, currentGoalID: existing.goalID }),
        )
      }
      const now = Date.now()
      const set: Record<string, unknown> = { time_updated: now }
      if (input.patch.outcome !== undefined) set.outcome = input.patch.outcome
      if (input.patch.verification !== undefined) set.verification = input.patch.verification
      if (input.patch.constraints !== undefined) set.constraints = input.patch.constraints
      if (input.patch.boundaries !== undefined) set.boundaries = input.patch.boundaries
      if (input.patch.iterationPolicy !== undefined) set.iteration_policy = input.patch.iterationPolicy
      if (input.patch.blockedCondition !== undefined) set.blocked_condition = input.patch.blockedCondition
      if (input.patch.tokenBudget !== undefined) set.token_budget = input.patch.tokenBudget
      yield* db.update(GoalTable).set(set).where(eq(GoalTable.goal_id, existing.goalID)).run().pipe(Effect.orDie)
      const row = yield* db
        .select()
        .from(GoalTable)
        .where(eq(GoalTable.goal_id, existing.goalID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* Effect.fail(new NotFoundError({ sessionID: input.sessionID }))
      const info = rowToInfo(row)
      yield* publishUpdated(info)
      return info
    })

    const patchStatus = Effect.fn("SessionGoal.patchStatus")(function* (input: {
      sessionID: SessionID
      patch: PatchStatusInput
      expectedGoalID?: SessionGoal.GoalID
    }) {
      // 整个验证+状态更新在同一事务
      return yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const row = yield* tx
            .select()
            .from(GoalTable)
            .where(eq(GoalTable.session_id, input.sessionID))
            .get()
            .pipe(Effect.orDie)
          if (!row) return yield* Effect.fail(new NotFoundError({ sessionID: input.sessionID }))
          const existing = rowToInfo(row)
          if (input.expectedGoalID && input.expectedGoalID !== existing.goalID) {
            return yield* Effect.fail(
              new StaleWrite({ expectedGoalID: input.expectedGoalID, currentGoalID: existing.goalID }),
            )
          }
          if (existing.status !== "active") {
            return yield* Effect.fail(
              new InvalidState({ detail: "goal not active", currentStatus: existing.status }),
            )
          }
          const callIDs = input.patch.evidenceCallIDs
          if (callIDs.length < MIN_EVIDENCE || callIDs.length > MAX_EVIDENCE) {
            return yield* Effect.fail(new InvalidEvidence({ detail: "evidence count must be 1-3" }))
          }
          // 证据验证需要读消息——在事务外用 sessionsSvc
          const evidence = yield* validateEvidence(input.sessionID, existing, callIDs)
          if (!evidence) {
            return yield* Effect.fail(new InvalidEvidence({ detail: "evidence callIDs invalid" }))
          }
          const now = Date.now()
          yield* tx
            .update(GoalTable)
            .set({ status: input.patch.status, evidence, time_updated: now })
            .where(eq(GoalTable.goal_id, existing.goalID))
            .run()
            .pipe(Effect.orDie)
          const updatedRow = yield* tx
            .select()
            .from(GoalTable)
            .where(eq(GoalTable.goal_id, existing.goalID))
            .get()
            .pipe(Effect.orDie)
          if (!updatedRow) return yield* Effect.fail(new NotFoundError({ sessionID: input.sessionID }))
          const info = rowToInfo(updatedRow)
          yield* events.publish(Event.Updated, { sessionID: info.sessionID, goal: info })
          return info
        }),
      )
    })

    const patchBudget = Effect.fn("SessionGoal.patchBudget")(function* (input: {
      sessionID: SessionID
      tokenBudget: number | null
      expectedGoalID?: SessionGoal.GoalID
    }) {
      const now = Date.now()
      return yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const row = yield* tx
            .select()
            .from(GoalTable)
            .where(eq(GoalTable.session_id, input.sessionID))
            .get()
            .pipe(Effect.orDie)
          if (!row) return yield* Effect.fail(new NotFoundError({ sessionID: input.sessionID }))
          const existing = rowToInfo(row)
          if (input.expectedGoalID && input.expectedGoalID !== existing.goalID) {
            return yield* Effect.fail(
              new StaleWrite({ expectedGoalID: input.expectedGoalID, currentGoalID: existing.goalID }),
            )
          }
          const newBudget = input.tokenBudget === null ? undefined : input.tokenBudget
          let newStatus: SessionGoal.Status = existing.status
          if (existing.status === "active") {
            if (newBudget !== undefined && existing.tokensUsed >= newBudget) {
              newStatus = "budget_limited"
            }
          } else if (existing.status === "budget_limited") {
            if (newBudget === undefined || newBudget > existing.tokensUsed) {
              newStatus = "active"
            }
            if (newBudget !== undefined && existing.tokensUsed >= newBudget) {
              newStatus = "budget_limited"
            }
          }
          // Effect SQLite 的无 returning 更新固定返回空数组，使用返回行判断 CAS 是否命中。
          const updated = yield* tx
            .update(GoalTable)
            .set({ token_budget: newBudget ?? null, status: newStatus, time_updated: now })
            .where(and(
              eq(GoalTable.goal_id, existing.goalID),
              eq(GoalTable.status, existing.status),
            ))
            .returning({ goalID: GoalTable.goal_id })
            .get()
            .pipe(Effect.orDie)
          if (!updated) {
            const currentRow = yield* tx
              .select()
              .from(GoalTable)
              .where(eq(GoalTable.goal_id, existing.goalID))
              .get()
              .pipe(Effect.orDie)
            if (!currentRow) return yield* Effect.fail(new NotFoundError({ sessionID: input.sessionID }))
            const current = rowToInfo(currentRow)
            return yield* Effect.fail(
              new StaleWrite({ expectedGoalID: existing.goalID, currentGoalID: current.goalID }),
            )
          }
          const updatedRow = yield* tx
            .select()
            .from(GoalTable)
            .where(eq(GoalTable.goal_id, existing.goalID))
            .get()
            .pipe(Effect.orDie)
          if (!updatedRow) return yield* Effect.fail(new NotFoundError({ sessionID: input.sessionID }))
          const info = rowToInfo(updatedRow)
          yield* events.publish(Event.Updated, { sessionID: info.sessionID, goal: info })
          return info
        }),
      )
    })

    const settleUsage = Effect.fn("SessionGoal.settleUsage")(function* (input: {
      sessionID: SessionID
      goalID: SessionGoal.GoalID
      expectedGoalID: SessionGoal.GoalID
      messageID: MessageID
      tokensInput: number
      tokensOutput: number
      tokensReasoning: number
      tokensCacheRead: number
      tokensCacheWrite: number
      timeSeconds: number
    }) {
      if (input.goalID !== input.expectedGoalID) {
        return yield* Effect.fail(
          new StaleWrite({ expectedGoalID: input.expectedGoalID, currentGoalID: input.goalID }),
        )
      }
      const deltaInput = Math.max(0, input.tokensInput)
      const deltaOutput = Math.max(0, input.tokensOutput)
      const deltaReasoning = Math.max(0, input.tokensReasoning)
      const deltaCacheRead = Math.max(0, input.tokensCacheRead)
      const deltaCacheWrite = Math.max(0, input.tokensCacheWrite)
      const deltaTime = Math.max(0, input.timeSeconds)
      const now = Date.now()
      return yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const goalRow = yield* tx
            .select()
            .from(GoalTable)
            .where(eq(GoalTable.goal_id, input.goalID))
            .get()
            .pipe(Effect.orDie)
          if (!goalRow) return undefined
          yield* tx
            .insert(GoalSettlementTable)
            .values({
              goal_id: input.goalID,
              assistant_message_id: input.messageID,
              tokens_input: deltaInput,
              tokens_output: deltaOutput,
              tokens_reasoning: deltaReasoning,
              tokens_cache_read: deltaCacheRead,
              tokens_cache_write: deltaCacheWrite,
              time_seconds: deltaTime,
              time_created: now,
            })
            .onConflictDoNothing()
            .run()
            .pipe(Effect.orDie)
          const settlements = yield* tx
            .select()
            .from(GoalSettlementTable)
            .where(eq(GoalSettlementTable.goal_id, input.goalID))
            .all()
            .pipe(Effect.orDie)
          const totalInput = settlements.reduce((s, r) => s + r.tokens_input, 0)
          const totalOutput = settlements.reduce((s, r) => s + r.tokens_output, 0)
          const totalReasoning = settlements.reduce((s, r) => s + r.tokens_reasoning, 0)
          const totalCacheRead = settlements.reduce((s, r) => s + r.tokens_cache_read, 0)
          const totalCacheWrite = settlements.reduce((s, r) => s + r.tokens_cache_write, 0)
          const totalTime = settlements.reduce((s, r) => s + r.time_seconds, 0)
          const newTokensUsed = totalInput + totalOutput + totalReasoning + totalCacheRead + totalCacheWrite
          yield* tx
            .update(GoalTable)
            .set({
              tokens_used: newTokensUsed,
              time_used_seconds: totalTime,
              time_updated: now,
            })
            .where(eq(GoalTable.goal_id, input.goalID))
            .run()
            .pipe(Effect.orDie)
          // 仅 active 状态可由结算切入预算限制，避免覆盖并发写入的 complete / blocked。
          if (goalRow.token_budget !== null && newTokensUsed >= goalRow.token_budget) {
            yield* tx
              .update(GoalTable)
              .set({ status: "budget_limited" })
              .where(and(
                eq(GoalTable.goal_id, input.goalID),
                eq(GoalTable.status, "active"),
              ))
              .run()
              .pipe(Effect.orDie)
          }
          const updatedRow = yield* tx
            .select()
            .from(GoalTable)
            .where(eq(GoalTable.goal_id, input.goalID))
            .get()
            .pipe(Effect.orDie)
          if (!updatedRow) return undefined
          const info = rowToInfo(updatedRow)
          yield* events.publish(Event.Updated, { sessionID: info.sessionID, goal: info })
          return info
        }),
      )
    })

    const addLesson = Effect.fn("SessionGoal.addLesson")(function* (input: {
      sessionID: SessionID
      input: AddLessonInput
      expectedGoalID?: SessionGoal.GoalID
    }) {
      return yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const row = yield* tx
            .select()
            .from(GoalTable)
            .where(eq(GoalTable.session_id, input.sessionID))
            .get()
            .pipe(Effect.orDie)
          if (!row) return yield* Effect.fail(new NotFoundError({ sessionID: input.sessionID }))
          const existing = rowToInfo(row)
          if (input.expectedGoalID && input.expectedGoalID !== existing.goalID) {
            return yield* Effect.fail(
              new StaleWrite({ expectedGoalID: input.expectedGoalID, currentGoalID: existing.goalID }),
            )
          }
          if (existing.status !== "active") {
            return yield* Effect.fail(
              new InvalidState({ detail: "goal not active", currentStatus: existing.status }),
            )
          }
          if (
            input.input.attempt.length > MAX_TEXT ||
            input.input.observed.length > MAX_TEXT ||
            input.input.implication.length > MAX_TEXT
          ) {
            return yield* Effect.fail(new InvalidEvidence({ detail: "text exceeds 240 chars" }))
          }
          const callIDs = input.input.evidenceCallIDs
          if (callIDs.length < MIN_EVIDENCE || callIDs.length > MAX_EVIDENCE) {
            return yield* Effect.fail(new InvalidEvidence({ detail: "evidence count must be 1-3" }))
          }
          const activeRows = yield* tx
            .select()
            .from(LessonTable)
            .where(and(eq(LessonTable.goal_id, existing.goalID), isNull(LessonTable.time_disabled)))
            .all()
            .pipe(Effect.orDie)
          if (activeRows.length >= MAX_LESSONS) {
            return yield* Effect.fail(new InvalidEvidence({ detail: "max 5 active lessons" }))
          }
          const evidence = yield* validateEvidence(input.sessionID, existing, callIDs)
          if (!evidence) {
            return yield* Effect.fail(new InvalidEvidence({ detail: "evidence callIDs invalid" }))
          }
          const now = Date.now()
          const lessonID = SessionGoal.LessonID.make("lsn_" + ulid())
          yield* tx
            .insert(LessonTable)
            .values({
              id: lessonID,
              goal_id: existing.goalID,
              session_id: input.sessionID,
              attempt: input.input.attempt,
              observed: input.input.observed,
              implication: input.input.implication,
              evidence: evidence.map((e) => ({ callID: e.callID, tool: e.tool, excerpt: e.excerpt })),
              time_created: now,
              time_disabled: null,
            })
            .run()
            .pipe(Effect.orDie)
          const lesson: Lesson = {
            id: lessonID,
            goalID: existing.goalID,
            attempt: input.input.attempt,
            observed: input.input.observed,
            implication: input.input.implication,
            evidence: evidence.map((e) => ({ callID: e.callID, tool: e.tool, excerpt: e.excerpt })),
            createdAt: now,
          }
          yield* events.publish(Event.LessonUpdated, {
            sessionID: input.sessionID,
            goalID: existing.goalID,
            lesson,
          })
          return lesson
        }),
      )
    })

    const disableLesson = Effect.fn("SessionGoal.disableLesson")(function* (input: {
      sessionID: SessionID
      lessonID: SessionGoal.LessonID
    }) {
      const goal = yield* requireGoal(input.sessionID)
      const now = Date.now()
      yield* db
        .update(LessonTable)
        .set({ time_disabled: now })
        .where(and(eq(LessonTable.id, input.lessonID), eq(LessonTable.goal_id, goal.goalID)))
        .run()
        .pipe(Effect.orDie)
      const rows = yield* db
        .select()
        .from(LessonTable)
        .where(and(eq(LessonTable.id, input.lessonID), eq(LessonTable.goal_id, goal.goalID)))
        .all()
        .pipe(Effect.orDie)
      if (rows.length === 0) {
        return yield* Effect.fail(new NotFoundError({ sessionID: input.sessionID }))
      }
      for (const row of rows) {
        const lesson = rowToLesson(row)
        yield* events.publish(Event.LessonUpdated, {
          sessionID: input.sessionID,
          goalID: goal.goalID,
          lesson,
        })
      }
    })

    const deleteLesson = Effect.fn("SessionGoal.deleteLesson")(function* (input: {
      sessionID: SessionID
      lessonID: SessionGoal.LessonID
    }) {
      const goal = yield* requireGoal(input.sessionID)
      const existing = yield* db
        .select()
        .from(LessonTable)
        .where(and(eq(LessonTable.id, input.lessonID), eq(LessonTable.goal_id, goal.goalID)))
        .all()
        .pipe(Effect.orDie)
      if (existing.length === 0) {
        return yield* Effect.fail(new NotFoundError({ sessionID: input.sessionID }))
      }
      yield* db
        .delete(LessonTable)
        .where(and(eq(LessonTable.id, input.lessonID), eq(LessonTable.goal_id, goal.goalID)))
        .run()
        .pipe(Effect.orDie)
      yield* events.publish(Event.LessonDeleted, {
        sessionID: input.sessionID,
        goalID: goal.goalID,
        lessonID: input.lessonID,
      })
    })

    return Service.of({
      get,
      lessons,
      allLessons,
      createOrReplace: createOrReplace as Interface["createOrReplace"],
      clear,
      pause,
      resume,
      patchContract,
      patchStatus: patchStatus as Interface["patchStatus"],
      patchBudget: patchBudget as Interface["patchBudget"],
      settleUsage: settleUsage as Interface["settleUsage"],
      addLesson: addLesson as Interface["addLesson"],
      disableLesson,
      deleteLesson,
    })
  }),
)

function extractExcerpt(part: SessionV1.ToolPart): string {
  if (part.state.status !== "completed") return ""
  const output = part.state.output ?? ""
  return output.length > EXCERPT_MAX ? output.slice(0, EXCERPT_MAX) + "..." : output
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [EventV2Bridge.node, Database.node, Session.node],
})

export * as Goal from "./goal"
