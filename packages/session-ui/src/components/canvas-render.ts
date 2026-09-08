import DOMPurify from "dompurify"
import { Marked, Renderer, type Token, type Tokens } from "marked"
import { CANVAS_GRAPH_STYLE, createCanvasTheme } from "./canvas-theme"
import { katexExtension, renderKatexToken } from "@opencode-ai/ui/context/marked"

export type CanvasResult = { ok: true; html: string } | { ok: false; error: string }

const SUPPORTED_DIAGRAMS = [
  { type: "flowchart", pattern: /^(?:flowchart|graph)(?=[\s;{]|$)/ },
  { type: "sequenceDiagram", pattern: /^sequenceDiagram(?=[\s;]|$)/ },
  { type: "stateDiagram-v2", pattern: /^stateDiagram-v2(?=[\s;]|$)/ },
  { type: "erDiagram", pattern: /^erDiagram(?=[\s;]|$)/ },
] as const

const MERMAID_MAX_CODE_LENGTH = 20000
const MERMAID_MAX_LINES = 400
const MERMAID_MAX_TEXT_SIZE = 50000
const MERMAID_MAX_EDGES = 500

/** 画布 markdown 解析独立实例，禁用原始 HTML，避免影响聊天 markdown 的全局配置 */
const renderer = new Renderer()
renderer.html = () => ""
// 画布内点击链接不得替换 OpenCode 页，仅放行 http(s) 外链新窗口打开，其余降级为纯文本
renderer.link = function ({ href, tokens }) {
  const text = this.parser.parseInline(tokens)
  if (!/^https?:\/\//i.test(href)) return text
  return `<a href="${href.replace(/"/g, "&quot;")}" target="_blank" rel="noopener noreferrer">${text}</a>`
}

const marked = new Marked({
  breaks: true,
  gfm: true,
  renderer,
})

// 与聊天共用公式分词和渲染；先以占位节点通过正文白名单，随后只恢复 KaTeX 生成的内容。
marked.use({
  extensions: katexExtension.extensions?.map((extension) => ({
    ...extension,
    renderer(token: Tokens.Generic) {
      return `<span data-canvas-formula="${encodeURIComponent(renderKatexToken(token))}"></span>`
    },
  })),
})

const PURIFY_MARKDOWN = {
  ALLOWED_TAGS: [
    "p",
    "br",
    "hr",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "li",
    "blockquote",
    "pre",
    "code",
    "strong",
    "em",
    "del",
    "a",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "span",
  ],
  ALLOWED_ATTR: ["href", "target", "rel", "start", "align", "data-canvas-formula"],
}

const PURIFY_SVG = {
  USE_PROFILES: { svg: true, svgFilters: true },
  ADD_TAGS: ["style"],
  FORBID_TAGS: ["foreignObject", "iframe", "image", "use", "script", "a"],
  FORBID_CONTENTS: ["script"],
  FORBID_ATTR: ["href", "xlink:href"],
}

/** 模型传入的配置 / 样式 / 交互指令一律整图拒绝，不做局部剥除，避免改变图语义；direction 布局与 accTitle/accDescr 可访问文本保留 */
const FORBIDDEN_STATEMENT = new RegExp(
  String.raw`(?:^|[;\n\r])\s*(?:` +
    [
      String.raw`%%\s*init\b`,
      String.raw`classDef\b`,
      String.raw`class\s+\S`,
      String.raw`style\s+\S`,
      String.raw`linkStyle\b`,
      String.raw`click\b`,
      String.raw`config\s*[{:]`,
      String.raw`theme\s*[:{]`,
      String.raw`icon\s*\(`,
      String.raw`img\s*\(`,
      String.raw`image\s*\(`,
      String.raw`links?\s+`,
      String.raw`rect\s+`,
    ].join("|") +
    String.raw`)`,
  "i",
)
/** init 指令可出现在任意位置并覆盖宿主配置，任何 %%{ 都直接拒绝 */
const INIT_DIRECTIVE_ANYWHERE = /%%\{/
/** frontmatter 可能携带 theme / config / icon 资源，同样整图拒绝 */
const FRONTMATTER = /^\s*---[ \t]*\r?\n[^]*?\r?\n---[ \t]*(?:\r?\n|$)/

function detectDiagramType(code: string) {
  const trimmed = code.trim()
  return SUPPORTED_DIAGRAMS.find((diagram) => diagram.pattern.test(trimmed))
}

/** 模型原文校验通过才允许进入 mermaid，任何宿主不掌控的指令都直接失败 */
function checkMermaidCode(code: string): CanvasResult | undefined {
  const trimmed = code.trim()
  if (!trimmed) return { ok: false, error: "空白的 mermaid 图表" }
  if (trimmed.length > MERMAID_MAX_CODE_LENGTH) return { ok: false, error: "mermaid 图表超出大小限制" }
  if (trimmed.split("\n").length > MERMAID_MAX_LINES) return { ok: false, error: "mermaid 图表超出大小限制" }
  if (FRONTMATTER.test(trimmed)) return { ok: false, error: "mermaid 图表不允许携带 frontmatter 配置" }
  if (INIT_DIRECTIVE_ANYWHERE.test(trimmed)) return { ok: false, error: "mermaid 图表不允许携带 init 配置指令" }
  if (!detectDiagramType(trimmed)) {
    return { ok: false, error: "仅支持 flowchart/graph、sequenceDiagram、stateDiagram-v2、erDiagram 图表" }
  }
  if (FORBIDDEN_STATEMENT.test(trimmed) || /:::|@\{|<\/?[a-z]/i.test(trimmed)) {
    return { ok: false, error: "mermaid 图表包含宿主不支持的样式 / 交互指令，请只保留图形结构与文本" }
  }
  return undefined
}

/** 提取宿主主题色值给 mermaid themeVariables，保证亮暗主题一致 */
function themeVariables() {
  const style = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  const scheme = style.colorScheme.trim()
  const isDark = scheme === "dark" || (scheme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches)
  const shared = createCanvasTheme(isDark, {
    background: read("--surface-raised-stronger-non-alpha", isDark ? "#1c1c1c" : "#ffffff"),
    text: read("--text-strong", isDark ? "#ededed" : "#171717"),
    font: read("--font-family-sans", "sans-serif"),
  })

  // 强化图表节点与连线对比度：克制蓝青底色与明确互动描边，避免发灰发暗
  const nodeBkg = shared.accentSurface
  const nodeBorder = shared.colors[1]
  const textStrong = shared.text
  const lineCol = shared.line
  const cardBkg = shared.background
  const surfaceBkg = shared.surface
  const borderWeak = shared.border
  // 图表网格与刻度使用最弱一档边框与弱文本色，避免细线过密过重压过数据
  const gridLine = shared.grid
  const textWeak = shared.muted

  return {
    chart: shared,
    mermaid: {
      darkMode: isDark,
      gridColor: gridLine,
      mutedTextColor: textWeak,
      background: cardBkg,
      primaryColor: nodeBkg,
      primaryBorderColor: nodeBorder,
      primaryTextColor: textStrong,
      lineColor: lineCol,
      secondaryColor: surfaceBkg,
      secondaryBorderColor: borderWeak,
      secondaryTextColor: textStrong,
      tertiaryColor: surfaceBkg,
      tertiaryBorderColor: borderWeak,
      tertiaryTextColor: textStrong,
      textColor: textStrong,
      mainBkg: nodeBkg,
      nodeBorder: nodeBorder,
      nodeTextColor: textStrong,
      clusterBkg: surfaceBkg,
      clusterBorder: borderWeak,
      edgeLabelBackground: cardBkg,
      fontFamily: shared.font,
      fontSize: `${CANVAS_GRAPH_STYLE.labelSize}px`,
      actorBkg: surfaceBkg,
      actorBorder: borderWeak,
      actorTextColor: textStrong,
      actorLineColor: lineCol,
      signalColor: lineCol,
      signalTextColor: textStrong,
      labelBoxBkgColor: nodeBkg,
      labelBoxBorderColor: nodeBorder,
      labelTextColor: textStrong,
      loopTextColor: textStrong,
      noteBkgColor: cardBkg,
      noteBorderColor: borderWeak,
      noteTextColor: textStrong,
      stateBkg: surfaceBkg,
      stateBorder: borderWeak,
      entityBkg: surfaceBkg,
      entityBorder: borderWeak,
      attributeBackgroundColorOdd: surfaceBkg,
      attributeBackgroundColorEven: cardBkg,
      transitionColor: lineCol,
      transitionLabelColor: textStrong,
    },
  }
}

function sanitizeMarkdownHtml(html: string): string {
  if (!DOMPurify.isSupported) throw new Error("Canvas sanitization is unavailable")
  const clean = DOMPurify.sanitize(html, PURIFY_MARKDOWN)
  if (!clean.includes("data-canvas-formula")) return clean
  const template = document.createElement("template")
  template.innerHTML = clean
  for (const formula of template.content.querySelectorAll("[data-canvas-formula]")) {
    const output = DOMPurify.sanitize(decodeURIComponent(formula.getAttribute("data-canvas-formula")!), {
      USE_PROFILES: { html: true, mathMl: true, svg: true },
      FORBID_TAGS: ["script", "style", "iframe", "img", "image", "a", "foreignObject"],
      FORBID_ATTR: ["href", "xlink:href"],
      RETURN_DOM_FRAGMENT: true,
    })
    formula.replaceWith(output)
  }
  return template.innerHTML
}

function sanitizeDiagramSvg(svg: string): string {
  if (!DOMPurify.isSupported) throw new Error("Canvas sanitization is unavailable")
  const clean = DOMPurify.sanitize(svg, PURIFY_SVG)
  if (!clean.trim()) throw new Error("The diagram did not produce a valid SVG")
  // Mermaid 的百分比宽度在图片模式下会放大小图；以 viewBox 固定原生尺寸，仅允许容器缩小。
  const document = new DOMParser().parseFromString(clean, "image/svg+xml")
  const root = document.documentElement
  if (root.localName !== "svg" || document.querySelector("parsererror")) throw new Error("Invalid diagram SVG")
  const bounds = root
    .getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number)
  const width = bounds?.[2]
  const height = bounds?.[3]
  if (width && height && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    root.setAttribute("width", String(width))
    root.setAttribute("height", String(height))
    const image = new XMLSerializer().serializeToString(root)
    return `<img alt="Diagram" width="${width}" height="${height}" style="width:${width}px;max-width:100%;height:auto" src="data:image/svg+xml,${encodeURIComponent(image)}">`
  }
  // SVG 图片拥有独立文档，保留宿主生成的样式但不向应用注入 CSS、脚本或外部资源。
  return `<img alt="Diagram" src="data:image/svg+xml,${encodeURIComponent(clean)}">`
}

interface CanvasSegment {
  kind: "markdown" | "diagram" | "chart"
  index: number
  markdown?: Token[]
  code?: string
}

function parseCanvasMarkdown(content: string): CanvasSegment[] {
  const tokens = marked.lexer(content)
  const segments: CanvasSegment[] = []
  let markdown: Token[] = []
  let index = 0

  const flush = () => {
    if (!markdown.length) return
    segments.push({ kind: "markdown", index: -1, markdown })
    markdown = []
  }

  for (const token of tokens) {
    const code = token as Tokens.Code
    const language = code.lang?.trim().toLowerCase()
    if (token.type === "code" && (language === "mermaid" || language === "vega-lite")) {
      flush()
      segments.push({ kind: language === "mermaid" ? "diagram" : "chart", index: index++, code: code.text })
      continue
    }
    markdown.push(token)
  }
  flush()
  return segments
}

/** mermaid.initialize / render 修改全局配置，跨文档渲染也必须串行排队 */
let queue: Promise<unknown> = Promise.resolve()

export function renderCanvas(content: string): Promise<CanvasResult> {
  const next = queue.then(() => renderCanvasSerial(content))
  queue = next.catch(() => undefined)
  return next
}

async function renderCanvasSerial(content: string): Promise<CanvasResult> {
  const segments = parseCanvasMarkdown(content)
  const diagrams = segments.filter((segment) => segment.kind === "diagram")
  const charts = segments.filter((segment) => segment.kind === "chart")
  if (diagrams.length + charts.length > 32)
    return { ok: false, error: "A canvas supports at most 32 diagrams; split this explanation into smaller documents." }
  for (const segment of diagrams) {
    const invalid = checkMermaidCode(segment.code ?? "")
    if (invalid) return invalid
  }
  const svgs = new Map<number, string>()

  if (charts.length) {
    const { renderCanvasChart } = await import("./canvas-chart")
    const theme = themeVariables()
    for (const chart of charts) {
      try {
        // 图表 SVG 背景与画布纸面同一底色，图表无独立卡片面
        const svg = await renderCanvasChart(chart.code ?? "", theme.chart)
        svgs.set(chart.index, sanitizeDiagramSvg(svg))
      } catch (cause) {
        return { ok: false, error: `Vega-Lite: ${describeError(cause)}` }
      }
    }
  }

  if (diagrams.length) {
    const { default: mermaid } = await import("mermaid")
    const theme = themeVariables().mermaid
    // 宿主独占主题与排版，模型侧 init / theme / classDef 等指令已被前置拒绝
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      themeVariables: theme,
      // 流程节点使用中性底面，菱形保留主题强调色；样式只由宿主生成，不接收文档 CSS。
      themeCSS: `
        .node rect, .node circle, .node ellipse, .node path {
          fill: ${theme.secondaryColor};
          stroke: ${theme.secondaryBorderColor};
          stroke-width: ${CANVAS_GRAPH_STYLE.strokeWidth}px;
        }
        .node rect { rx: 4px; ry: 4px; }
        .node polygon {
          fill: ${theme.primaryColor};
          stroke: ${theme.primaryBorderColor};
          stroke-width: ${CANVAS_GRAPH_STYLE.strokeWidth}px;
        }
        .node .label { font-weight: 500; }
        .flowchart-link { stroke: ${theme.lineColor}; stroke-width: ${CANVAS_GRAPH_STYLE.strokeWidth}px; }
        .edgeLabel { font-size: ${CANVAS_GRAPH_STYLE.labelSize}px; color: ${theme.mutedTextColor}; }
        .edgeLabel rect { fill: ${theme.background}; opacity: 1; }
        .edgeLabel text { fill: ${theme.mutedTextColor}; }
        .actor { stroke-width: ${CANVAS_GRAPH_STYLE.strokeWidth}px; }
        .statediagram-state rect, .er.entityBox {
          stroke-width: ${CANVAS_GRAPH_STYLE.strokeWidth}px;
        }
        .messageLine0, .messageLine1, .actor-line {
          stroke: ${theme.lineColor}; stroke-width: ${CANVAS_GRAPH_STYLE.strokeWidth}px;
        }
      `,
      maxTextSize: MERMAID_MAX_TEXT_SIZE,
      maxEdges: MERMAID_MAX_EDGES,
      suppressErrorRendering: true,
      htmlLabels: false,
      dompurifyConfig: { FORBID_TAGS: ["img", "image", "iframe", "foreignObject"] },
      // 压缩横向空隙而非缩小文字，长路线等比适配面板后仍保留清晰的阅读节奏。
      flowchart: { htmlLabels: false, padding: 16, nodeSpacing: 40, rankSpacing: 32, curve: "basis" },
      sequence: {
        mirrorActors: false,
        actorMargin: 40,
        messageMargin: 28,
        boxMargin: 8,
        actorFontSize: CANVAS_GRAPH_STYLE.labelSize,
        messageFontSize: CANVAS_GRAPH_STYLE.labelSize,
        noteFontSize: CANVAS_GRAPH_STYLE.labelSize,
      },
    })
    for (const segment of diagrams) {
      const id = `canvas-diagram-${crypto.randomUUID()}`
      try {
        const output = await mermaid.render(id, segment.code ?? "")
        svgs.set(segment.index, sanitizeDiagramSvg(output.svg))
      } catch (cause) {
        return { ok: false, error: describeError(cause) }
      }
    }
  }

  const html = segments
    .map((segment) => {
      if (segment.kind === "markdown") {
        return sanitizeMarkdownHtml(marked.parser(segment.markdown ?? []))
      }
      return `<figure class="canvas-diagram" data-diagram-kind="${segment.kind}" data-diagram-index="${segment.index}">${svgs.get(segment.index) ?? ""}</figure>`
    })
    .join("\n")
  return { ok: true, html }
}

export function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message || cause.name
  return String(cause)
}
