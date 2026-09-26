import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Todo } from "@/session/todo"
import { TodoReadTool, TodoWriteTool } from "@/tool/todo"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { MessageID, SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const sessionID = SessionID.make("ses_todo_test")
const otherID = SessionID.make("ses_todo_other")

const ctx: Tool.Context = {
  sessionID,
  messageID: MessageID.make("msg_todo_test"),
  callID: "todo_call",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const todoLayer = Layer.succeed(
  Todo.Service,
  Todo.Service.of({
    get: (id) => Effect.succeed(id === sessionID ? [{ content: "current", status: "in_progress", priority: "high" }] : []),
    update: (input) =>
      Effect.sync(() => {
        updates.push(input.todos)
      }),
  }),
)
const updates: ReadonlyArray<Todo.Info>[] = []

const it = testEffect(Layer.mergeAll(LayerNode.compile(LayerNode.group([Truncate.node, Agent.node])), todoLayer))

describe("tool.todo", () => {
  it.instance("todoread returns the current session list without updates", () =>
    Effect.gen(function* () {
      const tool = yield* (yield* TodoReadTool).init()
      const result = yield* tool.execute({}, ctx)
      const other = yield* tool.execute({}, { ...ctx, sessionID: otherID })

      expect(result.title).toBe("1 todos")
      expect(JSON.parse(result.output)).toEqual([{ content: "current", status: "in_progress", priority: "high" }])
      expect(result.metadata.todos).toEqual([{ content: "current", status: "in_progress", priority: "high" }])
      expect(JSON.parse(other.output)).toEqual([])
    }),
  )

  it.instance("todowrite still replaces the persisted list", () =>
    Effect.gen(function* () {
      const todos = [{ content: "updated", status: "pending" as const, priority: "medium" as const }]
      const tool = yield* (yield* TodoWriteTool).init()
      const result = yield* tool.execute({ todos }, ctx)

      expect(result.title).toBe("1 todos")
      expect(JSON.parse(result.output)).toEqual(todos)
      expect(updates).toEqual([todos])
    }),
  )
})
