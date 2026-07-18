// Shared right rail (review / file tree). Chat width is stored; side width is the remainder.
export const SESSION_PANEL_WIDTH_MIN = 320
export const SIDE_PANEL_WIDTH_MIN = 200
export const REVIEW_PANE_WIDTH_MIN = 200
export const REVIEW_PANE_WIDTH_MIN_SPLIT = 200

export function sessionPanelWidthMax(input: { available: number; split?: boolean }) {
  return Math.max(SESSION_PANEL_WIDTH_MIN, input.available - SIDE_PANEL_WIDTH_MIN)
}

// `available` is undefined until the layout row is first measured; render the
// stored width untouched until then to avoid a first-frame snap.
export function clampSessionPanelWidth(input: {
  width: number
  available: number | undefined
  split?: boolean
}) {
  if (input.available === undefined) return input.width
  const max = sessionPanelWidthMax({ available: input.available })
  return Math.min(Math.max(input.width, SESSION_PANEL_WIDTH_MIN), max)
}
