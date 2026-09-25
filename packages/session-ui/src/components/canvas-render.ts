import DOMPurify from "dompurify"
import { Marked, Renderer, type Token, type Tokens } from "marked"
import { CANVAS_GRAPH_STYLE, createCanvasTheme } from "./canvas-theme"
import { highlightCode, katexExtension, renderKatexToken } from "@opencode-ai/ui/context/marked"

export type CanvasResult = { ok: true; html: string } | { ok: false; error: string }

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
// 普通代码块先以转义纯文本占位通过清洗，清洗后再交给 shiki 高亮，与公式的恢复方式一致。
renderer.code = ({ text, lang }) =>
  `<pre data-canvas-code="${encodeURIComponent(lang?.trim().split(/\s+/)[0] ?? "")}"><code>${escapeHtml(text)}</code></pre>\n`

// GitHub 风格提示块：`> [!TIP]` 等标记转为带类型的提示卡片，其余引用保持原样。
const CALLOUTS = ["note", "tip", "important", "warning", "caution"]
renderer.blockquote = function ({ tokens }) {
  const body = this.parser.parse(tokens)
  const match = /^<p>\[!(\w+)\][ \t]*(?:<br>\s*|\n)?/i.exec(body)
  const kind = match?.[1].toLowerCase()
  if (!match || !kind || !CALLOUTS.includes(kind)) return `<blockquote>\n${body}</blockquote>\n`
  const rest = body.slice(match[0].length).replace(/^<\/p>\s*/, "")
  const content = rest.startsWith("<") || !rest ? rest : `<p>${rest}`
  const title = kind[0].toUpperCase() + kind.slice(1)
  return `<blockquote data-canvas-callout="${kind}"><p data-canvas-callout-title="">${title}</p>\n${content}</blockquote>\n`
}

function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
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
  ALLOWED_ATTR: [
    "href",
    "target",
    "rel",
    "start",
    "align",
    "data-canvas-formula",
    "data-canvas-code",
    "data-canvas-callout",
    "data-canvas-callout-title",
  ],
}

const PURIFY_SVG = {
  USE_PROFILES: { svg: true, svgFilters: true },
  ADD_TAGS: ["style"],
  FORBID_TAGS: ["foreignObject", "iframe", "image", "use", "script", "a"],
  FORBID_CONTENTS: ["script"],
  FORBID_ATTR: ["href", "xlink:href"],
}

/** frontmatter 可能携带 theme / config / icon 资源，在进入 mermaid 前整块剥除 */
const FRONTMATTER = /^\s*---[ \t]*\r?\n[^]*?\r?\n---[ \t]*(?:\r?\n|$)/

/** 整行属于宿主不掌控的配置 / 样式 / 交互语句时剥除该语句，保留图形结构 */
const STRIP_STATEMENT = new RegExp(
  String.raw`^[ \t]*(?:` +
    [
      String.raw`%%\{[^]*?\}%%[ \t]*`, // %%{init:...}%% 指令行
      String.raw`%%[^\n\r]*`, // 其他 %% 注释 / 指令行
      String.raw`classDef\b[^\n\r;]*`,
      String.raw`class\s+[^\n\r;]*`,
      String.raw`style\s+[^\n\r;]*`,
      String.raw`linkStyle\b[^\n\r;]*`,
      String.raw`click\b[^\n\r;]*`,
    ].join("|") +
    String.raw`)[;\s]*$`,
  "gim",
)

/**
 * 模型侧可能带入样式 / 交互 / 配置语法。宿主独占外观与交互，渲染前把这些指令剥除；
 * 保留结构与纯文本，让绝大多数图都能直接出图而不是整图失败。
 */
export function sanitizeMermaidCode(code: string): string {
  let text = code.replace(FRONTMATTER, "")
  // mermaid 原生支持 <br/> 换行，保留；其余 HTML 标签整体剥除只留文本。
  text = text.replace(/<\/?(?!(?:br)\b)[a-z][^>]*>/gi, "")
  // flowchart 节点的 :::class 后缀与 @{...} 形状属性去掉。
  text = text.replace(/:::+[\w-]+/g, "").replace(/@\{[^}]*\}/g, "")
  text = text.replace(STRIP_STATEMENT, "")
  return text
}

/** 清洗后仍不合法（空、超长）才整图拒绝；图类型交给 mermaid 自身解析，全类型放行 */
function checkMermaidCode(code: string): CanvasResult | undefined {
  const trimmed = code.trim()
  if (!trimmed) return { ok: false, error: "空白的 mermaid 图表" }
  if (trimmed.length > MERMAID_MAX_CODE_LENGTH) return { ok: false, error: "mermaid 图表超出大小限制" }
  if (trimmed.split("\n").length > MERMAID_MAX_LINES) return { ok: false, error: "mermaid 图表超出大小限制" }
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
  const nodeBorder = shared.colors[0]
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

/** 在底色上按百分比混入强调色，供 SVG 内样式使用。 */
function tint(color: string, percent: number, base: string) {
  return `color-mix(in srgb, ${color} ${percent}%, ${base})`
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

/** 清洗后的代码占位替换为 shiki 高亮结果，并附语言标签；高亮失败时保留原纯文本代码块。 */
async function highlightCanvasCode(html: string): Promise<string> {
  if (!html.includes("data-canvas-code")) return html
  const template = document.createElement("template")
  template.innerHTML = html
  for (const pre of template.content.querySelectorAll<HTMLPreElement>("pre[data-canvas-code]")) {
    const lang = decodeURIComponent(pre.getAttribute("data-canvas-code") ?? "")
    const code = pre.textContent ?? ""
    const block = document.createElement("div")
    block.className = "canvas-code"
    if (lang) {
      const label = document.createElement("div")
      label.className = "canvas-code-lang"
      label.textContent = lang
      block.append(label)
    }
    const highlighted = await highlightCode(code, lang).catch(() => undefined)
    const holder = document.createElement("template")
    holder.innerHTML = highlighted ?? ""
    const shiki = holder.content.querySelector("pre")
    // 底色与字色交给画布样式统一控制，只保留 shiki 的逐词着色。
    shiki?.removeAttribute("style")
    pre.removeAttribute("data-canvas-code")
    block.append(shiki ?? pre.cloneNode(true))
    pre.replaceWith(block)
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
    const sanitized = sanitizeMermaidCode(segment.code ?? "")
    const invalid = checkMermaidCode(sanitized)
    if (invalid) return invalid
    segment.code = sanitized
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
    const { mermaid: theme, chart } = themeVariables()
    const brand = chart.colors[0]
    const accent = chart.colors[2]
    const shadow = theme.darkMode ? "rgba(0,0,0,0.35)" : "rgba(23,23,23,0.06)"
    // 宿主独占主题与排版，模型侧 init / theme / classDef 等指令已在 sanitizeMermaidCode 中剥除
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      themeVariables: theme,
      // 节点统一使用品牌色浅染底面 + 半透明品牌描边，判断节点换第二分类色区分；
      // 轻投影让节点浮在点阵底面之上。样式只由宿主生成，不接收文档 CSS。
      themeCSS: `
        .node rect, .node circle, .node ellipse, .node path,
        .statediagram-state rect, rect.actor, .er.entityBox, .er.attributeBoxOdd, .er.attributeBoxEven {
          fill: ${tint(brand, 10, theme.background)};
          stroke: ${tint(brand, 55, theme.background)};
          stroke-width: ${CANVAS_GRAPH_STYLE.strokeWidth}px;
        }
        .er.attributeBoxEven { fill: ${tint(brand, 4, theme.background)}; }
        .node rect, rect.actor, .statediagram-state rect { rx: 8px; ry: 8px; }
        .node polygon {
          fill: ${tint(accent, 12, theme.background)};
          stroke: ${tint(accent, 60, theme.background)};
          stroke-width: ${CANVAS_GRAPH_STYLE.strokeWidth}px;
        }
        .node, rect.actor, .statediagram-state, .er.entityBox {
          filter: drop-shadow(0 1px 1.5px ${shadow}) drop-shadow(0 4px 10px ${shadow});
        }
        .node .label, .actor tspan, .statediagram-state .nodeLabel { font-weight: 500; }
        .flowchart-link { stroke: ${theme.lineColor}; stroke-width: ${CANVAS_GRAPH_STYLE.lineWidth - 0.5}px; }
        .marker, marker path { fill: ${theme.lineColor}; stroke: ${theme.lineColor}; }
        .edgeLabel { font-size: ${CANVAS_GRAPH_STYLE.labelSize - 1}px; color: ${theme.mutedTextColor}; }
        .edgeLabel rect, .labelBkg { fill: ${theme.background}; background: ${theme.background}; opacity: 1; }
        .edgeLabel text { fill: ${theme.mutedTextColor}; }
        .statediagram-state rect, .er.entityBox { stroke-width: ${CANVAS_GRAPH_STYLE.strokeWidth}px; }
        .messageLine0, .messageLine1 {
          stroke: ${theme.lineColor}; stroke-width: ${CANVAS_GRAPH_STYLE.lineWidth - 0.5}px;
        }
        .actor-line { stroke: ${tint(brand, 35, theme.background)}; stroke-dasharray: 3 4; }
        .messageText { fill: ${theme.textColor}; font-weight: 500; }
        #arrowhead path, .arrowheadPath { fill: ${theme.lineColor}; stroke: ${theme.lineColor}; }
        circle.state-start, .state-end { fill: ${brand}; stroke: ${brand}; }
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

  const parts = await Promise.all(
    segments.map((segment) => {
      if (segment.kind === "markdown") {
        return highlightCanvasCode(sanitizeMarkdownHtml(marked.parser(segment.markdown ?? [])))
      }
      return `<figure class="canvas-diagram" data-diagram-kind="${segment.kind}" data-diagram-index="${segment.index}">${svgs.get(segment.index) ?? ""}</figure>`
    }),
  )
  return { ok: true, html: parts.join("\n") }
}

export function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message || cause.name
  return String(cause)
}
