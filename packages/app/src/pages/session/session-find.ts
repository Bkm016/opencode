import type { SessionFindHit } from "@opencode-ai/sdk/v2"

export type { SessionFindHit }

// 搜索在服务端扫完整历史；这里只做展示前的整理：
// 去掉已撤回（revert）之后的轮次，并按从新到旧排列，第一项就是离用户最近的命中。
export function orderFindHits(hits: readonly SessionFindHit[], revertMessageID?: string) {
  const kept = revertMessageID ? hits.filter((hit) => hit.userMessageID < revertMessageID) : hits.slice()
  return kept.reverse()
}

export function findHitKey(hit: Pick<SessionFindHit, "partID" | "ordinal">) {
  return `${hit.partID}:${hit.ordinal}`
}

export const FIND_FILTERS = ["all", "user", "assistant", "reasoning", "tool", "summary", "other"] as const
export type FindFilter = (typeof FIND_FILTERS)[number]

export function findHitFilter(hit: SessionFindHit): Exclude<FindFilter, "all"> {
  if (hit.kind === "text") return hit.role === "user" ? "user" : "assistant"
  if (hit.kind === "reasoning" || hit.kind === "tool" || hit.kind === "summary") return hit.kind
  return "other"
}

export type FindPreviewSegment = { text: string; mark?: "hit" | "active" }
export type FindPreviewLine = { no: number; segments: FindPreviewSegment[] }

// 预览只渲染命中附近的若干行；超长工具输出也不会一次塞进上万行
export function findPreviewLines(
  text: string,
  ranges: readonly { start: number; end: number }[],
  active: { start: number; end: number },
  radius = 120,
) {
  const starts = [0]
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) starts.push(at + 1)
  const lineOf = (offset: number) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid]! <= offset) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  const activeLine = lineOf(active.start)
  const first = Math.max(0, activeLine - radius)
  const last = Math.min(starts.length - 1, activeLine + radius)
  const sorted = ranges.slice().sort((a, b) => a.start - b.start)
  const lines: FindPreviewLine[] = []
  let cursor = 0
  for (let index = first; index <= last; index++) {
    const lineStart = starts[index]!
    const lineEnd = index + 1 < starts.length ? starts[index + 1]! - 1 : text.length
    const segments: FindPreviewSegment[] = []
    let at = lineStart
    while (cursor < sorted.length && sorted[cursor]!.end <= lineStart) cursor++
    for (let scan = cursor; scan < sorted.length && sorted[scan]!.start < lineEnd; scan++) {
      const range = sorted[scan]!
      const from = Math.max(range.start, lineStart)
      const to = Math.min(range.end, lineEnd)
      if (from > at) segments.push({ text: text.slice(at, from) })
      if (to > from) {
        const isActive = range.start === active.start && range.end === active.end
        segments.push({ text: text.slice(from, to), mark: isActive ? "active" : "hit" })
      }
      at = Math.max(at, to)
    }
    if (at < lineEnd) segments.push({ text: text.slice(at, lineEnd) })
    lines.push({ no: index + 1, segments })
  }
  return { lines, activeLine: activeLine + 1, clippedStart: first > 0, clippedEnd: last < starts.length - 1 }
}

export function filterFindHits(hits: readonly SessionFindHit[], filter: FindFilter, hideCompacted: boolean) {
  return hits.filter(
    (hit) => (!hideCompacted || !hit.compacted) && (filter === "all" || findHitFilter(hit) === filter),
  )
}
