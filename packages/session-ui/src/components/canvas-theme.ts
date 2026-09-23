/**
 * 画布图表统一宿主主题配置
 */
export interface CanvasChartTheme {
  background: string
  text: string
  muted: string
  grid: string
  font: string
  colors: string[]
  /** 小面积标记的连续色阶，暗底下不使用接近背景的深蓝端点。 */
  ramp?: string[]
}

// 两种绘图引擎共用文字尺度和线条重量，避免各自的默认值形成两套视觉语言。
export const CANVAS_GRAPH_STYLE = { labelSize: 13, titleSize: 14, strokeWidth: 1, lineWidth: 2 }

export function createCanvasTheme(dark: boolean, host: Partial<CanvasChartTheme> = {}) {
  return {
    background: dark ? "#1c1c1c" : "#ffffff",
    text: dark ? "#ededed" : "#171717",
    muted: dark ? "#a3a3a3" : "#737373",
    grid: dark ? "#333333" : "#e5e5e5",
    font: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    // 首个系列保持品牌蓝，单系列图表观感不变；多系列按固定顺序先走青、紫冷色，
    // 暖色只在第 4 类之后出现。同色系深浅无法区分相邻类别，此顺序经色觉与色盲区分度校验。
    colors: dark
      ? ["#3987e5", "#199e70", "#9085e9", "#c98500", "#d55181", "#008300"]
      : ["#2a78d6", "#1baf7a", "#4a3aa7", "#eda100", "#e87ba4", "#008300"],
    ramp: dark ? ["#4389e5", "#b9ddff"] : ["#74aceb", "#1645a0"],
    surface: dark ? "#242424" : "#fafafa",
    border: dark ? "#525252" : "#d4d4d4",
    accentSurface: dark ? "#303030" : "#f0f0f0",
    line: dark ? "#929292" : "#737373",
    ...host,
  }
}

export const DEFAULT_CANVAS_THEME = createCanvasTheme(false)
