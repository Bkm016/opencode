/**
 * Process-local registry for async child-session tasks.
 * task.ts calls registerTask / registerBatch on launch; task_status / task_wait / task_abort / task_followup
 * read getBatch / getTaskMeta for status, wait, and followup.
 */

export type TaskMeta = {
  title: string
  parentSessionId: string
  createdAt: number
  agent?: string
  batchId?: string
}

/** batch_id -> child session IDs (task_ids) */
const batches = new Map<string, string[]>()

/** session id (task_id) -> launch metadata */
export const taskMeta = new Map<string, TaskMeta>()

export function createBatchID() {
  return `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function registerBatch(batchId: string, sessionIds: readonly string[]) {
  batches.set(batchId, [...sessionIds])
  for (const sessionId of sessionIds) {
    const meta = taskMeta.get(sessionId)
    if (!meta) continue
    taskMeta.set(sessionId, { ...meta, batchId })
  }
}

export function getBatch(batchId: string) {
  return batches.get(batchId)
}

export function listBatches() {
  return batches
}

export function registerTask(sessionId: string, meta: TaskMeta) {
  const previous = taskMeta.get(sessionId)
  const batchId = meta.batchId ?? previous?.batchId
  taskMeta.set(sessionId, { ...previous, ...meta, batchId })
  if (!batchId) return
  const existing = batches.get(batchId) ?? []
  if (existing.includes(sessionId)) return
  batches.set(batchId, [...existing, sessionId])
}

export function getTaskMeta(sessionId: string) {
  return taskMeta.get(sessionId)
}
