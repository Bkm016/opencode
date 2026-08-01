import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION_GOAL_LESSON_ADD from "./goal-lesson-add.txt"
import { Goal } from "../session/goal"

export const GoalLessonAddParameters = Schema.Struct({
  attempt: Schema.String,
  observed: Schema.String,
  implication: Schema.String,
}).annotate({ description: "Add a lesson to the active Goal" })

type Metadata = {
  goalID: string
  lessonID: string
  attempt: string
}

export const GoalLessonAddTool = Tool.define<typeof GoalLessonAddParameters, Metadata, Goal.Service>(
  "goal_lesson_add",
  Effect.gen(function* () {
    const goal = yield* Goal.Service

    return {
      description: DESCRIPTION_GOAL_LESSON_ADD,
      parameters: GoalLessonAddParameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const result = yield* goal
            .addLesson({
              sessionID: ctx.sessionID,
              input: {
                attempt: params.attempt,
                observed: params.observed,
                implication: params.implication,
              },
            })
            .pipe(
              // 工具边界捕获所有错误，返回 Tool.Output，不泄露未声明 Effect error
              Effect.catch((error) =>
                Effect.succeed({
                  _tag: "error" as const,
                  message: `Failed to add lesson: ${
                    "detail" in error
                      ? error.detail
                      : error._tag === "SessionGoalNotFoundError"
                        ? "No active GOAL CONTRACT exists. No lesson is needed; continue the ordinary task without calling Goal tools."
                        : "the active Goal changed before the lesson was added"
                  }`,
                }),
              ),
            )

          // 错误路径直接返回
          if (typeof result === "object" && "_tag" in result && result._tag === "error") {
            return {
              title: "Lesson add failed",
              output: result.message,
              metadata: { goalID: "", lessonID: "", attempt: "" },
            }
          }

          // 成功路径
          const lesson = result as Goal.Lesson
          return {
            title: "Goal lesson added",
            output: `Lesson added for attempt: ${lesson.attempt}`,
            metadata: {
              goalID: lesson.goalID,
              lessonID: lesson.id,
              attempt: lesson.attempt,
            },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof GoalLessonAddParameters, Metadata>
  }),
)
