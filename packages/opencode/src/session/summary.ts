import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Context, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "./session"
import { SessionID, MessageID } from "./schema"
import { FileDiff } from "@opencode-ai/schema/file-diff"

export interface Interface {
  readonly summarize: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<void>
  readonly diff: (input: { sessionID: SessionID; messageID?: MessageID }) => Effect.Effect<FileDiff.Info[]>
  readonly computeDiff: (input: { messages: SessionV1.WithParts[] }) => Effect.Effect<FileDiff.Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSummary") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const events = yield* EventV2Bridge.Service

    // Snapshot is removed; no snapshot hashes are ever recorded on parts.
    const computeDiff = Effect.fn("SessionSummary.computeDiff")(
      (_input: { messages: SessionV1.WithParts[] }) => Effect.succeed([] as FileDiff.Info[]),
    )

    const summarize = Effect.fn("SessionSummary.summarize")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      yield* sessions.setSummary({
        sessionID: input.sessionID,
        summary: {
          additions: 0,
          deletions: 0,
          files: 0,
        },
      })
      yield* events.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: [] })
    })

    const diff = Effect.fn("SessionSummary.diff")(
      (_input: { sessionID: SessionID; messageID?: MessageID }) => Effect.succeed([] as FileDiff.Info[]),
    )

    return Service.of({ summarize, diff, computeDiff })
  }),
)

export const DiffInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
})
export type DiffInput = Schema.Schema.Type<typeof DiffInput>

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Session.node, EventV2Bridge.node],
})

export * as SessionSummary from "./summary"
