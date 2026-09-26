import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION_READ from "./todoread.txt"
import DESCRIPTION_WRITE from "./todowrite.txt"
import { Todo } from "../session/todo"

const NoParameters = Schema.Struct({})

export const Parameters = Schema.Struct({
  todos: Schema.mutable(Schema.Array(Todo.Info)).annotate({ description: "The updated todo list" }),
})

type Metadata = {
  todos: Todo.Info[]
}

export const TodoReadTool = Tool.define<typeof NoParameters, Metadata, Todo.Service>(
  "todoread",
  Effect.gen(function* () {
    const todo = yield* Todo.Service

    return {
      description: DESCRIPTION_READ,
      parameters: NoParameters,
      execute: (_params: Schema.Schema.Type<typeof NoParameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const todos = yield* todo.get(ctx.sessionID)

          return {
            title: `${todos.length} todos`,
            output: JSON.stringify(todos, null, 2),
            metadata: {
              todos,
            },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof NoParameters, Metadata>
  }),
)

export const TodoWriteTool = Tool.define<typeof Parameters, Metadata, Todo.Service>(
  "todowrite",
  Effect.gen(function* () {
    const todo = yield* Todo.Service

    return {
      description: DESCRIPTION_WRITE,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "todowrite",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })

          yield* todo.update({
            sessionID: ctx.sessionID,
            todos: params.todos,
          })

          return {
            title: `${params.todos.filter((x) => x.status !== "completed").length} todos`,
            output: JSON.stringify(params.todos, null, 2),
            metadata: {
              todos: params.todos,
            },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
