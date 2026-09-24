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

// 右侧抽屉覆盖在正文之上，宽度独立保存；至少给正文留出一条可见边，便于点回正文。
export const DRAWER_WIDTH_MIN = 320
const DRAWER_EDGE_MIN = 160
// 桌面抽屉与窗口边缘的间距，以及正文列让位时两侧保留的留白。
export const DRAWER_INSET = 8
export const DRAWER_COLUMN_GUTTER = 64

export function drawerWidthMax(available: number | undefined) {
  if (available === undefined) return Number.POSITIVE_INFINITY
  return Math.max(DRAWER_WIDTH_MIN, available - DRAWER_EDGE_MIN)
}

export function clampDrawerWidth(input: { width: number; available: number | undefined }) {
  return Math.min(Math.max(input.width, DRAWER_WIDTH_MIN), drawerWidthMax(input.available))
}
