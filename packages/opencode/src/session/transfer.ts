import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import {
  GoalTable,
  LessonTable,
  MessageTable,
  PartTable,
  SessionTable,
  TodoTable,
} from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { asc, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { NotFoundError } from "@/storage/storage"
import type { InstanceContext } from "../project/instance-context"
import { Session } from "./session"
import { MessageV2 } from "./message-v2"
import { Todo } from "./todo"
import { Goal } from "./goal"
import { SessionID } from "./schema"

// 换机迁移用的完整会话包，messages 之外还带 todos/goals，导入后可无缝继续。
export const Bundle = Schema.Struct({
  version: Schema.optional(Schema.Literal(1)),
  info: Session.Info,
  messages: Schema.Array(SessionV1.WithParts),
  todos: Schema.optional(Schema.Array(Todo.Info)),
  goal: Schema.optional(Schema.NullOr(Goal.Info)),
  lessons: Schema.optional(Schema.Array(Goal.Lesson)),
}).annotate({ identifier: "SessionTransferBundle" })
export type Bundle = typeof Bundle.Type

export const exportBundle = Effect.fn("SessionTransfer.export")(function* (sessionID: SessionID) {
  const { db } = yield* Database.Service
  const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
  if (!row) return yield* new NotFoundError({ message: `Session not found: ${sessionID}` })
  const messages = yield* MessageV2.stream(sessionID)
  const todoRows = yield* db
    .select()
    .from(TodoTable)
    .where(eq(TodoTable.session_id, sessionID))
    .orderBy(asc(TodoTable.position))
    .all()
    .pipe(Effect.orDie)
  const goalRow = yield* db
    .select()
    .from(GoalTable)
    .where(eq(GoalTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  const goal = goalRow
    ? {
        goalID: goalRow.goal_id,
        sessionID: goalRow.session_id,
        outcome: goalRow.outcome,
        verification: goalRow.verification,
        constraints: goalRow.constraints,
        boundaries: goalRow.boundaries,
        iterationPolicy: goalRow.iteration_policy,
        ...(goalRow.blocked_condition !== null ? { blockedCondition: goalRow.blocked_condition } : {}),
        ...(goalRow.token_budget !== null ? { tokenBudget: goalRow.token_budget } : {}),
        tokensUsed: goalRow.tokens_used,
        timeUsedSeconds: goalRow.time_used_seconds,
        status: goalRow.status,
        evidence: goalRow.evidence ?? [],
        createdAt: goalRow.time_created,
        updatedAt: goalRow.time_updated,
      }
    : null
  const lessonRows = goalRow
    ? yield* db
        .select()
        .from(LessonTable)
        .where(eq(LessonTable.goal_id, goalRow.goal_id))
        .orderBy(asc(LessonTable.time_created))
        .all()
        .pipe(Effect.orDie)
    : []
  return {
    version: 1 as const,
    info: Session.fromRow(row),
    messages,
    todos: todoRows.map((todo) => ({
      content: todo.content,
      status: todo.status,
      priority: todo.priority,
    })),
    goal,
    lessons: lessonRows.map((lesson) => ({
      id: lesson.id,
      goalID: lesson.goal_id,
      attempt: lesson.attempt,
      observed: lesson.observed,
      implication: lesson.implication,
      evidence: lesson.evidence,
      createdAt: lesson.time_created,
      ...(lesson.time_disabled !== null ? { disabledAt: lesson.time_disabled } : {}),
    })),
  } satisfies Bundle
})

const decodeMessageInfo = Schema.decodeUnknownSync(SessionV1.Info)
const decodePart = Schema.decodeUnknownSync(SessionV1.Part)

export const importBundle = Effect.fn("SessionTransfer.import")(function* (bundle: Bundle, ctx: InstanceContext) {
  const { db } = yield* Database.Service
  const info = {
    ...bundle.info,
    projectID: ctx.project.id,
    directory: ctx.directory,
    path: path.relative(path.resolve(ctx.worktree), ctx.directory).replaceAll("\\", "/"),
  } as Session.Info
  const row = Session.toRow(info)
  yield* db
    .insert(SessionTable)
    .values(row)
    .onConflictDoUpdate({
      target: SessionTable.id,
      set: { project_id: row.project_id, directory: row.directory, path: row.path },
    })
    .run()
    .pipe(Effect.orDie)

  for (const msg of bundle.messages) {
    const msgInfo = decodeMessageInfo(msg.info) as SessionV1.Info
    const { id, sessionID: _, ...msgData } = msgInfo
    yield* db
      .insert(MessageTable)
      .values({
        id,
        session_id: row.id,
        time_created: msgInfo.time?.created ?? Date.now(),
        data: msgData as never,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    for (const part of msg.parts) {
      const partInfo = decodePart(part) as SessionV1.Part
      const { id: partId, sessionID: _s, messageID, ...partData } = partInfo
      yield* db
        .insert(PartTable)
        .values({
          id: partId,
          message_id: messageID,
          session_id: row.id,
          data: partData,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    }
  }

  // todos 全量替换，顺序即 position，换机后继续跟踪同一批任务。
  yield* db.delete(TodoTable).where(eq(TodoTable.session_id, row.id)).run().pipe(Effect.orDie)
  const todos = bundle.todos ?? []
  if (todos.length > 0) {
    yield* db
      .insert(TodoTable)
      .values(
        todos.map((todo, position) => ({
          session_id: row.id,
          content: todo.content,
          status: todo.status,
          priority: todo.priority,
          position,
        })),
      )
      .run()
      .pipe(Effect.orDie)
  }

  // goal 按 session 全量替换，lessons 随 goal 重建，tokens/耗时随 Goal 行保留。
  if (bundle.goal !== undefined) {
    yield* db.delete(GoalTable).where(eq(GoalTable.session_id, row.id)).run().pipe(Effect.orDie)
    if (bundle.goal) {
      const goal = bundle.goal
      yield* db
        .insert(GoalTable)
        .values({
          goal_id: goal.goalID,
          session_id: row.id,
          outcome: goal.outcome,
          verification: [...goal.verification],
          constraints: [...goal.constraints],
          boundaries: [...goal.boundaries],
          iteration_policy: goal.iterationPolicy,
          blocked_condition: goal.blockedCondition ?? null,
          token_budget: goal.tokenBudget ?? null,
          tokens_used: goal.tokensUsed,
          time_used_seconds: goal.timeUsedSeconds,
          status: goal.status,
          evidence: [...goal.evidence],
          time_created: goal.createdAt,
          time_updated: goal.updatedAt,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const lessons = bundle.lessons ?? []
      for (const lesson of lessons) {
        yield* db
          .insert(LessonTable)
          .values({
            id: lesson.id,
            goal_id: lesson.goalID,
            session_id: row.id,
            attempt: lesson.attempt,
            observed: lesson.observed,
            implication: lesson.implication,
            evidence: [...lesson.evidence],
            time_created: lesson.createdAt,
            time_disabled: lesson.disabledAt ?? null,
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
      }
    }
  }

  return info
})

export * as SessionTransfer from "./transfer"
