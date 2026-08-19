import type { DisposeCheck, EvictPlan } from "./types"

export function pickDirectoriesToEvict(input: EvictPlan) {
  const overflow = Math.max(0, input.stores.length - input.max)
  let pendingOverflow = overflow
  const sorted = input.stores
    .filter((dir) => !input.pins.has(dir))
    .slice()
    .sort((a, b) => (input.state.get(a)?.lastAccessAt ?? 0) - (input.state.get(b)?.lastAccessAt ?? 0))
  const output: string[] = []
  for (const dir of sorted) {
    const last = input.state.get(dir)?.lastAccessAt ?? 0
    const idle = input.now - last >= input.ttl
    // overflow 驱逐也跳过最近访问的目录：memo 批量读取（如 enrich）会刷新
    // lastAccessAt，刚访问的 store 若因 overflow 被驱逐，下次读取又重建，
    // 形成 dispose→recreate 轮转，每秒重建数百个 persist store 导致内存疯涨。
    const recentlyAccessed = input.now - last < RECENT_ACCESS_PROTECT_MS
    if (!idle && (pendingOverflow <= 0 || recentlyAccessed)) continue
    output.push(dir)
    if (pendingOverflow > 0) pendingOverflow -= 1
  }
  return output
}

// 最近访问保护窗口：该时长内被访问的目录即使 overflow 也不驱逐。
const RECENT_ACCESS_PROTECT_MS = 30_000

export function canDisposeDirectory(input: DisposeCheck) {
  if (!input.directory) return false
  if (!input.hasStore) return false
  if (input.pinned) return false
  if (input.booting) return false
  if (input.loadingSessions) return false
  return true
}
