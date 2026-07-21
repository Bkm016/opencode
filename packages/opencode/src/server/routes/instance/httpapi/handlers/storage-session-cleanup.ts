export const SESSION_RETENTION_DAYS = 7

export type SessionCleanupRow = {
  id: string
  project_id: string
  parent_id: string | null
  time_updated: number
  time_archived: number | null
}

export type SessionCleanupPlan = {
  retentionDays: typeof SESSION_RETENTION_DAYS
  // 规则 A：打开项目集合为空时标 unavailable 且不删，避免刚启动误判
  unloadedProjects: "available" | "unavailable"
  // 规则命中候选数（子树安全过滤前）
  candidates: number
  // 因非候选后代或 parent cycle 而阻塞的候选数
  blocked: number
  // 计划删除的 session id（含可安全删除子树中的全部节点）
  removableIDs: string[]
  // 仅最顶层 root，交给 Session.remove 级联
  roots: string[]
}

/**
 * 构造可安全删除的 session 计划。
 * 规则 A：project 不在打开集合且 time_updated < cutoff（打开集合为空时跳过）。
 * 规则 B：time_archived 存在且 time_archived < cutoff（始终评估）。
 * 仅整棵候选子树可删；parent cycle 节点永不删。
 */
export function planSessionCleanup(input: {
  rows: readonly SessionCleanupRow[]
  openProjectIDs: ReadonlySet<string>
  cutoff: number
}): SessionCleanupPlan {
  const unloadedProjects = input.openProjectIDs.size === 0 ? "unavailable" : "available"
  const candidates = new Set<string>()
  for (const row of input.rows) {
    const byUnloaded =
      unloadedProjects === "available" &&
      !input.openProjectIDs.has(row.project_id) &&
      row.time_updated < input.cutoff
    const byArchived = row.time_archived !== null && row.time_archived < input.cutoff
    if (byUnloaded || byArchived) candidates.add(row.id)
  }

  const children = new Map<string, string[]>()
  const parentOf = new Map<string, string | null>()
  for (const row of input.rows) {
    parentOf.set(row.id, row.parent_id)
    if (!row.parent_id) continue
    const list = children.get(row.parent_id)
    if (list) list.push(row.id)
    else children.set(row.parent_id, [row.id])
  }

  const cyclic = detectCyclicSessions(parentOf)
  const removable = new Set<string>()
  const subtreeMemo = new Map<string, boolean>()
  for (const id of candidates) {
    if (cyclic.has(id)) continue
    if (subtreeAllCandidates(id, children, candidates, cyclic, subtreeMemo)) removable.add(id)
  }

  const roots: string[] = []
  for (const id of removable) {
    const parent = parentOf.get(id)
    if (parent && removable.has(parent)) continue
    roots.push(id)
  }

  return {
    retentionDays: SESSION_RETENTION_DAYS,
    unloadedProjects,
    candidates: candidates.size,
    blocked: candidates.size - removable.size,
    removableIDs: [...removable],
    roots,
  }
}

function detectCyclicSessions(parentOf: Map<string, string | null>) {
  const cyclic = new Set<string>()
  const state = new Map<string, "visiting" | "done">()
  const stack: string[] = []

  const visit = (id: string) => {
    const seen = state.get(id)
    if (seen === "done") return
    if (seen === "visiting") {
      const start = stack.indexOf(id)
      if (start >= 0) for (const node of stack.slice(start)) cyclic.add(node)
      return
    }
    state.set(id, "visiting")
    stack.push(id)
    const parent = parentOf.get(id)
    if (parent && parentOf.has(parent)) visit(parent)
    stack.pop()
    state.set(id, "done")
  }

  for (const id of parentOf.keys()) visit(id)
  return cyclic
}

function subtreeAllCandidates(
  id: string,
  children: Map<string, string[]>,
  candidates: Set<string>,
  cyclic: Set<string>,
  memo: Map<string, boolean>,
): boolean {
  const cached = memo.get(id)
  if (cached !== undefined) return cached
  if (!candidates.has(id) || cyclic.has(id)) {
    memo.set(id, false)
    return false
  }
  for (const child of children.get(id) ?? []) {
    if (!subtreeAllCandidates(child, children, candidates, cyclic, memo)) {
      memo.set(id, false)
      return false
    }
  }
  memo.set(id, true)
  return true
}
