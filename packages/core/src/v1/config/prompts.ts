export * as ConfigPromptsV1 from "./prompts"

import { Schema } from "effect"

/** User overrides for built-in LLM prompts. Keys match the prompt catalog id. */
export const Info = Schema.Record(Schema.String, Schema.String).annotate({
  description:
    "Override built-in prompts by id (system.*, agent.*, session.*, tool.*, command.*, compaction.*, runtime.*). Empty string restores the default.",
})

export type Info = Schema.Schema.Type<typeof Info>
