export const REPETITION_WINDOW = 4096
const REPETITION_MIN_CHARS = 180
const REPETITION_MIN_CYCLES = 3

// Require three exact long suffix cycles so repeated words and list structure do not trigger the guard.
export function detectRepetition(text: string): boolean {
  const length = text.length
  if (length < REPETITION_MIN_CHARS) return false

  const win = length > REPETITION_WINDOW ? text.slice(length - REPETITION_WINDOW) : text
  const len = win.length
  if (len < REPETITION_MIN_CHARS) return false

  const maxPeriod = Math.floor(len / REPETITION_MIN_CYCLES)
  const minPeriod = Math.ceil(REPETITION_MIN_CHARS / REPETITION_MIN_CYCLES)
  if (maxPeriod < minPeriod) return false

  const last = win.charCodeAt(len - 1)
  const from = len - 1 - maxPeriod
  for (let j = len - 1 - minPeriod; j >= from; j--) {
    if (win.charCodeAt(j) !== last) continue
    const p = len - 1 - j
    const period = win.slice(len - p)
    if (win.slice(len - 3 * p, len - 2 * p) === period && win.slice(len - 2 * p, len - p) === period) {
      return true
    }
  }
  return false
}
