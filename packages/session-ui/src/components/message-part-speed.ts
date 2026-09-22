// 流式阶段后端尚无真实 token 计数，按约 4 字符折算 1 token 估算实时速度；完成后用真实 output 校准。
export const CHARS_PER_TOKEN = 4

export function estimateOutputTokens(text: string): number {
  if (!text) return 0
  return text.length / CHARS_PER_TOKEN
}

export function speedFromTokens(
  tokens: number,
  elapsedMs: number,
): { tps: number; tpotMs: number } | undefined {
  if (!(tokens > 0)) return undefined
  if (!(elapsedMs > 0)) return undefined
  return { tps: (tokens * 1000) / elapsedMs, tpotMs: elapsedMs / tokens }
}

export function formatSpeed(tps: number, tpotMs: number, format: (value: number) => string): string {
  return `${format(tps)} tok/s · ${format(tpotMs)}ms/tok`
}
