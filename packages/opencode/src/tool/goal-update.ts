import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION_GOAL_UPDATE from "./goal-update.txt"
import { Goal } from "../session/goal"

export const GoalUpdateParameters = Schema.Struct({
  status: Schema.Literals(["complete", "blocked"]),
}).annotate({ description: "Update the active Goal status to complete or blocked" })

type Metadata = {
  goalID: string
  status: string
}

export const GoalUpdateTool = Tool.define<typeof GoalUpdateParameters, Metadata, Goal.Service>(
  "goal_update",
  Effect.gen(function* () {
    const goal = yield* Goal.Service

    return {
      description: DESCRIPTION_GOAL_UPDATE,
      parameters: GoalUpdateParameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const result = yield* goal
            .patchStatus({
              sessionID: ctx.sessionID,
              patch: {
                status: params.status,
              },
            })
            .pipe(
              // 工具边界捕获所有错误，返回 Tool.Output，不泄露未声明 Effect error
              Effect.catch((error) =>
                Effect.succeed({
                  _tag: "error" as const,
                  message: `Failed to update goal status: ${
                    "detail" in error
                      ? error.detail
                      : error._tag === "SessionGoalNotFoundError"
                        ? "No active GOAL CONTRACT exists. No update is needed; continue the ordinary task without calling Goal tools."
                        : "the active Goal changed before the update"
                  }`,
                }),
              ),
            )

          // 错误路径直接返回
          if (typeof result === "object" && "_tag" in result && result._tag === "error") {
            return {
              title: "Goal update failed",
              output: result.message,
              metadata: { goalID: "", status: params.status },
            }
          }

          // 成功路径
          const info = result as Goal.Info
          return {
            title: `Goal ${params.status}`,
            output: `Goal marked as ${params.status}.`,
            metadata: {
              goalID: info.goalID,
              status: params.status,
            },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof GoalUpdateParameters, Metadata>
  }),
)
