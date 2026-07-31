export * as Command from "./command"

import { Schema } from "effect"
import { AbsolutePath, optional } from "./schema"
import { Model } from "./model"

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  name: Schema.String,
  template: Schema.String,
  description: Schema.String.pipe(optional),
  agent: Schema.String.pipe(optional),
  model: Model.Ref.pipe(optional),
  subtask: Schema.Boolean.pipe(optional),
  source: Schema.Literals(["command", "mcp", "skill", "run"]).pipe(optional),
}).annotate({ identifier: "CommandV2.Info" })

export const RunConfig = Schema.Struct({
  scripts: Schema.Record(Schema.String, Schema.String),
}).annotate({ identifier: "CommandV2.RunConfig" })
export interface RunConfig extends Schema.Schema.Type<typeof RunConfig> {}

export const RunFile = Schema.Struct({
  path: AbsolutePath,
  scripts: Schema.Record(Schema.String, Schema.String),
}).annotate({ identifier: "Command.RunFile" })
export interface RunFile extends Schema.Schema.Type<typeof RunFile> {}
