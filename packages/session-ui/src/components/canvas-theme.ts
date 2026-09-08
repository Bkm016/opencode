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
    // 首个系列保持中性，额外类别使用可辨认的标准色，不把装饰性配色强加给每张图。
    // 当前按参考图使用同色系蓝色层次，不再混入白色大扇区或跨色相的黄绿装饰色。
    colors: ["#8ec5ff", "#2b7fff", "#155dfc", "#1447e6", "#193cb8", "#0d2466"],
    ramp: dark ? ["#4389e5", "#b9ddff"] : ["#74aceb", "#1645a0"],
    surface: dark ? "#242424" : "#fafafa",
    border: dark ? "#525252" : "#d4d4d4",
    accentSurface: dark ? "#303030" : "#f0f0f0",
    line: dark ? "#929292" : "#737373",
    ...host,
  }
}

export const DEFAULT_CANVAS_THEME = createCanvasTheme(false)
