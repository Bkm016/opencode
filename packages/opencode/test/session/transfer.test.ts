import { expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { GoalTable, LessonTable, MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Session as SessionNs } from "@/session/session"
import { SessionTransfer } from "@/session/transfer"
import { Todo } from "@/session/todo"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { MessageID, PartID } from "../../src/session/schema"
import { requireInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionNs.node,
      Todo.node,
      Database.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

it.instance("transfer roundtrips export -> json -> import", () =>
  Effect.gen(function* () {
    const session = yield* SessionNs.Service
    const todo = yield* Todo.Service
    const { db } = yield* Database.Service
    const ctx = yield* requireInstance

    const info = yield* session.create({ title: "transfer-test" })

    const messageID = MessageID.ascending()
    const now = Date.now()
    yield* db
      .insert(MessageTable)
      .values({
        id: messageID,
        session_id: info.id,
        time_created: now,
        data: {
          role: "user",
          time: { created: now },
          model: { providerID: "test-provider", modelID: "test-model" },
        } as never,
      })
      .run()
      .pipe(Effect.orDie)
    const partID = PartID.ascending()
    yield* db
      .insert(PartTable)
      .values({
        id: partID,
        message_id: messageID,
        session_id: info.id,
        data: { type: "text", text: "hello transfer" },
      })
      .run()
      .pipe(Effect.orDie)

    yield* todo.update({
      sessionID: info.id,
      todos: [
        { content: "first", status: "in_progress", priority: "high" },
        { content: "second", status: "pending", priority: "low" },
      ],
    })

    yield* db
      .insert(GoalTable)
      .values({
        goal_id: "goal_test123" as never,
        session_id: info.id,
        outcome: "ship it",
        verification: [],
        constraints: [],
        boundaries: [],
        iteration_policy: "iterate",
        blocked_condition: null,
        token_budget: null,
        tokens_used: 0,
        time_used_seconds: 0,
        status: "active",
        evidence: [],
        time_created: now,
        time_updated: now,
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(LessonTable)
      .values({
        id: "lsn_test123" as never,
        goal_id: "goal_test123" as never,
        session_id: info.id,
        attempt: "tried",
        observed: "saw",
        implication: "do it",
        evidence: [],
        time_created: now,
        time_disabled: null,
      })
      .run()
      .pipe(Effect.orDie)

    // 模拟真实链路：导出 -> JSON 序列化 -> 解码 -> 导入。
    const exported = yield* SessionTransfer.exportBundle(info.id)
    const json = JSON.stringify(exported)
    const decoded = yield* Schema.decodeUnknownEffect(SessionTransfer.Bundle)(JSON.parse(json))
    const imported = yield* SessionTransfer.importBundle(decoded, ctx)

    expect(imported.id).toBe(info.id)
    expect(decoded.messages).toHaveLength(1)
    expect(decoded.messages[0]?.parts).toHaveLength(1)
    expect(decoded.todos).toHaveLength(2)
    expect(decoded.goal?.outcome).toBe("ship it")
    expect(decoded.lessons).toHaveLength(1)

    const messages = yield* session.messages({ sessionID: info.id })
    expect(messages).toHaveLength(1)
    const todos = yield* todo.get(info.id)
    expect(todos).toHaveLength(2)

    const goalRows = yield* db
      .select()
      .from(GoalTable)
      .where(eq(GoalTable.session_id, info.id))
      .all()
      .pipe(Effect.orDie)
    expect(goalRows).toHaveLength(1)

    yield* session.remove(info.id)
  }),
)
