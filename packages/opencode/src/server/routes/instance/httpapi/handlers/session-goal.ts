import { Goal } from "@/session/goal"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import * as SessionError from "./session-errors"

export const goalHandlers = HttpApiBuilder.group(InstanceHttpApi, "goal", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Goal.Service
    const sessionSvc = yield* Session.Service
    const promptSvc = yield* SessionPrompt.Service

    const requireSession = Effect.fn("GoalHttpApi.requireSession")(function* (sessionID: SessionID) {
      yield* SessionError.mapStorageNotFound(sessionSvc.get(sessionID))
    })

    const get = Effect.fn("GoalHttpApi.get")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      const result = yield* svc.get(ctx.params.sessionID)
      return result ?? null
    })

    const create = Effect.fn("GoalHttpApi.create")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: Omit<Goal.CreateInput, "sessionID"> & {
        expectedGoalID?: Goal.GoalID
        confirmReplace?: boolean
        agent?: string
        providerID?: string
        modelID?: string
        variant?: string
      }
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* svc.createOrReplace({
        ...ctx.payload,
        sessionID: ctx.params.sessionID,
        ...(ctx.payload.expectedGoalID ? { expectedGoalID: ctx.payload.expectedGoalID } : {}),
        ...(ctx.payload.confirmReplace ? { confirmReplace: ctx.payload.confirmReplace } : {}),
      })
      const wakeOptions: { agent?: string; providerID?: ProviderV2.ID; modelID?: ModelV2.ID; variant?: string } = {}
      if (ctx.payload.agent) wakeOptions.agent = ctx.payload.agent
      if (ctx.payload.providerID) wakeOptions.providerID = ProviderV2.ID.make(ctx.payload.providerID)
      if (ctx.payload.modelID) wakeOptions.modelID = ModelV2.ID.make(ctx.payload.modelID)
      if (ctx.payload.variant) wakeOptions.variant = ctx.payload.variant
      return yield* promptSvc.wakeGoal(ctx.params.sessionID, wakeOptions)
    })

    const clear = Effect.fn("GoalHttpApi.clear")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      yield* svc.clear(ctx.params.sessionID)
      return true
    })

    const patchContract = Effect.fn("GoalHttpApi.patchContract")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: Goal.PatchContractInput & { expectedGoalID?: Goal.GoalID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      const { expectedGoalID, ...patch } = ctx.payload
      return yield* svc.patchContract({
        sessionID: ctx.params.sessionID,
        patch,
        ...(expectedGoalID ? { expectedGoalID } : {}),
      })
    })

    const patchStatus = Effect.fn("GoalHttpApi.patchStatus")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: Goal.PatchStatusInput & { expectedGoalID?: Goal.GoalID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      const { expectedGoalID, ...patch } = ctx.payload
      return yield* svc.patchStatus({
        sessionID: ctx.params.sessionID,
        patch,
        ...(expectedGoalID ? { expectedGoalID } : {}),
      })
    })

    const patchBudget = Effect.fn("GoalHttpApi.patchBudget")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: { tokenBudget: number | null; expectedGoalID?: Goal.GoalID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      const { expectedGoalID, ...rest } = ctx.payload
      return yield* svc.patchBudget({
        sessionID: ctx.params.sessionID,
        tokenBudget: rest.tokenBudget,
        ...(expectedGoalID ? { expectedGoalID } : {}),
      })
    })

    const clearBudget = Effect.fn("GoalHttpApi.clearBudget")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: { expectedGoalID: Goal.GoalID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* svc.patchBudget({
        sessionID: ctx.params.sessionID,
        tokenBudget: null,
        expectedGoalID: ctx.payload.expectedGoalID,
      })
    })

    const pause = Effect.fn("GoalHttpApi.pause")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      const result = yield* svc.pause(ctx.params.sessionID)
      if (!result) return yield* Effect.fail(new Goal.NotFoundError({ sessionID: ctx.params.sessionID }))
      return result
    })

    const resume = Effect.fn("GoalHttpApi.resume")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      yield* svc.resume(ctx.params.sessionID)
      return yield* promptSvc.wakeGoal(ctx.params.sessionID)
    })

    const wake = Effect.fn("GoalHttpApi.wake")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* promptSvc.wakeGoal(ctx.params.sessionID)
    })

    const addLesson = Effect.fn("GoalHttpApi.addLesson")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: Goal.AddLessonInput & { expectedGoalID?: Goal.GoalID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      const { expectedGoalID, ...input } = ctx.payload
      return yield* svc.addLesson({
        sessionID: ctx.params.sessionID,
        input,
        ...(expectedGoalID ? { expectedGoalID } : {}),
      })
    })

    const deleteLesson = Effect.fn("GoalHttpApi.deleteLesson")(function* (ctx: {
      params: { sessionID: SessionID; lessonID: Goal.LessonID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* svc.deleteLesson({ sessionID: ctx.params.sessionID, lessonID: ctx.params.lessonID })
      return true
    })

    const disableLesson = Effect.fn("GoalHttpApi.disableLesson")(function* (ctx: {
      params: { sessionID: SessionID; lessonID: Goal.LessonID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* svc.disableLesson({ sessionID: ctx.params.sessionID, lessonID: ctx.params.lessonID })
      return true
    })

    const lessons = Effect.fn("GoalHttpApi.lessons")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      const goal = yield* svc.get(ctx.params.sessionID)
      if (!goal) return yield* Effect.fail(new Goal.NotFoundError({ sessionID: ctx.params.sessionID }))
      return yield* svc.allLessons(goal.goalID)
    })

    return handlers
      .handle("get", get)
      .handle("create", create)
      .handle("clear", clear)
      .handle("patchContract", patchContract)
      .handle("patchStatus", patchStatus)
      .handle("patchBudget", patchBudget)
      .handle("clearBudget", clearBudget)
      .handle("pause", pause)
      .handle("resume", resume)
      .handle("wake", wake)
      .handle("addLesson", addLesson)
      .handle("disableLesson", disableLesson)
      .handle("deleteLesson", deleteLesson)
      .handle("lessons", lessons)
  }),
)
