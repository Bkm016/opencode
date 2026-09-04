export * as SkillCloud from "./skill-cloud"

import { Schema } from "effect"
import { AbsolutePath, NonNegativeInt, optional } from "./schema"

export const StatusState = Schema.Literals(["unconfigured", "ready", "modified", "ahead", "behind", "diverged"])
export type StatusState = typeof StatusState.Type

export interface Status extends Schema.Schema.Type<typeof Status> {}
export const Status = Schema.Struct({
  name: Schema.String,
  state: StatusState,
  configured: Schema.Boolean,
  repository: Schema.String.pipe(optional),
  branch: Schema.String.pipe(optional),
  directory: AbsolutePath,
  head: Schema.String.pipe(optional),
  changes: NonNegativeInt,
  ahead: NonNegativeInt,
  behind: NonNegativeInt,
}).annotate({ identifier: "SkillCloud.Status" })

export interface ConfigureInput extends Schema.Schema.Type<typeof ConfigureInput> {}
export const ConfigureInput = Schema.Struct({
  name: Schema.String.pipe(optional),
  repository: Schema.Trim.pipe(Schema.check(Schema.isNonEmpty())),
}).annotate({ identifier: "SkillCloud.ConfigureInput" })

export interface UpdateInput extends Schema.Schema.Type<typeof UpdateInput> {}
export const UpdateInput = Schema.Struct({
  name: Schema.String.pipe(optional),
}).annotate({ identifier: "SkillCloud.UpdateInput" })

export interface SyncInput extends Schema.Schema.Type<typeof SyncInput> {}
export const SyncInput = Schema.Struct({
  name: Schema.String.pipe(optional),
  message: Schema.String.pipe(optional),
}).annotate({ identifier: "SkillCloud.SyncInput" })

export interface RemoveInput extends Schema.Schema.Type<typeof RemoveInput> {}
export const RemoveInput = Schema.Struct({
  name: Schema.Trim.pipe(Schema.check(Schema.isNonEmpty())),
}).annotate({ identifier: "SkillCloud.RemoveInput" })

export const ErrorReason = Schema.Literals([
  "not_found",
  "not_configured",
  "invalid_repository",
  "directory_conflict",
  "authentication",
  "working_tree_dirty",
  "merge_conflict",
  "git_unavailable",
  "operation_failed",
])
export type ErrorReason = typeof ErrorReason.Type
