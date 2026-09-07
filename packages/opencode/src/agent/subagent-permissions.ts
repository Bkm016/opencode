import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Agent } from "./agent"
import { Permission } from "../permission"

const TASK_LAUNCH_TOOLS = ["task"] as const

/** Tools that launch or orchestrate child sessions; denied by default on nested subagents. */
export const ORCHESTRATION_TOOLS = [
  ...TASK_LAUNCH_TOOLS,
  "task_status",
  "task_wait",
  "task_abort",
  "task_followup",
] as const

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. The parent session's deny rules and external_directory rules.
 *    Parent agent restrictions only govern that agent; the subagent's own
 *    permissions determine its capabilities.
 * 2. Default `todowrite` and orchestration-tool denies if the subagent's own
 *    ruleset doesn't already permit them (blocks nested task).
 * 任务级授权覆盖上述编排工具默认例外：只有 allowNestedTasks 才能省略默认禁止。
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: PermissionV1.Ruleset
  subagent: Agent.Info
  allowNestedTasks?: boolean
  primaryTools?: string[]
}): PermissionV1.Ruleset {
  const canTodo = input.subagent.permission.some((rule) => rule.permission === "todowrite")
  // 任务授权优先于代理自身能力；开放嵌套只省略默认禁止，不移除父会话的限制。
  const orchestrationDenies = input.allowNestedTasks
    ? []
    : ORCHESTRATION_TOOLS.map((permission) => ({ permission, pattern: "*" as const, action: "deny" as const }))
  return [
    ...input.parentSessionPermission.filter(
      (rule) => rule.permission === "external_directory" || rule.action === "deny",
    ),
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...orchestrationDenies,
    ...(input.primaryTools ?? []).map((permission) => ({
      permission,
      pattern: "*" as const,
      action: "deny" as const,
    })),
  ]
}

export function canDelegateTasks(subagent: Agent.Info, permission: PermissionV1.Ruleset) {
  const disabled = Permission.disabled([...TASK_LAUNCH_TOOLS], Permission.merge(subagent.permission, permission))
  return TASK_LAUNCH_TOOLS.some((tool) => !disabled.has(tool))
}
