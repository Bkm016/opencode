import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Agent } from "./agent"

/** Tools that launch or orchestrate child sessions; denied by default on nested subagents. */
export const ORCHESTRATION_TOOLS = [
  "task",
  "project_task",
  "task_async",
  "task_async_status",
  "task_async_wait",
  "task_async_abort",
  "task_async_followup",
] as const

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. The parent session's deny rules and external_directory rules.
 *    Parent agent restrictions only govern that agent; the subagent's own
 *    permissions determine its capabilities.
 * 2. Default `todowrite` and orchestration-tool denies if the subagent's own
 *    ruleset doesn't already permit them (blocks nested task / task_async_*).
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: PermissionV1.Ruleset
  subagent: Agent.Info
}): PermissionV1.Ruleset {
  const canTodo = input.subagent.permission.some((rule) => rule.permission === "todowrite")
  const orchestrationDenies = ORCHESTRATION_TOOLS.flatMap((permission) =>
    input.subagent.permission.some((rule) => rule.permission === permission)
      ? []
      : [{ permission, pattern: "*" as const, action: "deny" as const }],
  )
  return [
    ...input.parentSessionPermission.filter(
      (rule) => rule.permission === "external_directory" || rule.action === "deny",
    ),
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...orchestrationDenies,
  ]
}
