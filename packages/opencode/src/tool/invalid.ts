import { Effect, Schema } from "effect"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  tool: Schema.String,
  error: Schema.String,
  input: Schema.optional(Schema.Unknown),
})

export const InvalidTool = Tool.define(
  "invalid",
  Effect.succeed({
    description: "Do not use",
    parameters: Parameters,
    execute: (params: { tool: string; error: string; input?: unknown }) => {
      let output = `The arguments provided to the tool are invalid: ${params.error}`
      if (params.input !== undefined) {
        const raw = typeof params.input === "string" ? params.input : JSON.stringify(params.input, null, 2)
        output += `\n\nRaw arguments provided by the model:\n${raw}`
      }
      return Effect.succeed({
        title: `Invalid Tool (${params.tool})`,
        output,
        metadata: {
          tool: params.tool,
          error: params.error,
          input: params.input,
        },
      })
    },
  }),
)
