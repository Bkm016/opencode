import type { Loader } from "vega"
import type { Config, TopLevelSpec } from "vega-lite"

import { CANVAS_GRAPH_STYLE, DEFAULT_CANVAS_THEME, type CanvasChartTheme } from "./canvas-theme"

const MAX_SOURCE_BYTES = 256 * 1024
const MAX_TOTAL_ROWS = 10000
const MAX_LAYERS = 16
const MAX_SPEC_DEPTH = 12
const CHART_WIDTH = 640
const CHART_HEIGHT = 320

const ALLOWED_ROOT_KEYS = new Set([
  "$schema",
  "description",
  "title",
  "width",
  "height",
  "data",
  "mark",
  "encoding",
  "layer",
])
const ALLOWED_LAYER_KEYS = new Set(["mark", "encoding", "data"])
const ALLOWED_DATA_KEYS = new Set(["values"])
const ALLOWED_MARKS = new Set([
  "bar",
  "line",
  "area",
  "point",
  "circle",
  "square",
  "arc",
  "tick",
  "rule",
  "text",
  "rect",
])
const ALLOWED_MARK_KEYS = new Set(["type", "innerRadius", "outerRadius", "point"])
const ALLOWED_CHANNELS = new Set([
  "x",
  "y",
  "x2",
  "y2",
  "xOffset",
  "yOffset",
  "color",
  "size",
  "theta",
  "theta2",
  "radius",
  "text",
  "detail",
  "order",
])
const ALLOWED_CHANNEL_KEYS = new Set([
  "field",
  "type",
  "aggregate",
  "stack",
  "timeUnit",
  "bin",
  "sort",
  "title",
  "axis",
  "legend",
  "scale",
  "format",
  "value",
  "band",
])
const ALLOWED_SCALE_KEYS = new Set(["domain", "type", "zero", "reverse"])
const ALLOWED_AXIS_KEYS = new Set([
  "title",
  "format",
  "formatType",
  "orient",
  "values",
  "tickCount",
  "labels",
  "ticks",
  "grid",
])
const ALLOWED_LEGEND_KEYS = new Set(["title", "format", "formatType", "orient", "values", "tickCount"])
const ALLOWED_FORMAT_TYPES = new Set(["number", "time"])
const ALLOWED_ORIENTS = new Set(["top", "bottom", "left", "right"])

// 彻底拦截网络与本地文件 IO，防止任何外部资源逃逸
const SAFE_LOADER: Loader = {
  load: () => Promise.reject(new Error("External data loading is disabled")),
  sanitize: (uri: string) => Promise.reject(new Error(`External resource access denied: ${uri}`)),
  http: () => Promise.reject(new Error("Network access is disabled")),
  file: () => Promise.reject(new Error("File system access is disabled")),
}

function checkDepth(value: unknown, depth = 1): void {
  if (depth > MAX_SPEC_DEPTH) throw new Error(`Specification nesting exceeds maximum depth of ${MAX_SPEC_DEPTH}`)
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key !== "data" && child && typeof child === "object") checkDepth(child, depth + 1)
    }
  }
}

function validateData(data: unknown): Record<string, unknown>[] {
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("Data must be an object with a values array")
  for (const key of Object.keys(data as Record<string, unknown>)) {
    if (!ALLOWED_DATA_KEYS.has(key)) throw new Error(`Property "${key}" is forbidden in data; only "values" is allowed`)
  }
  const values = (data as Record<string, unknown>).values
  if (!Array.isArray(values)) throw new Error("Data values must be an array")
  for (const row of values) {
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw new Error("Data rows must be flat primitive records")
    // 仅校验字段标量值，业务列名不做限制（允许 url/expr 等业务列）
    for (const val of Object.values(row as Record<string, unknown>)) {
      if (val === null || val === undefined) continue
      if (typeof val === "number") {
        if (!Number.isFinite(val)) throw new Error("Data contains non-finite numeric values (NaN or Infinity)")
      } else if (typeof val !== "string" && typeof val !== "boolean") {
        throw new Error("Data values must be flat primitives")
      }
    }
  }
  return values as Record<string, unknown>[]
}

function validateMark(mark: unknown): string | Record<string, unknown> {
  if (typeof mark === "string") {
    if (!ALLOWED_MARKS.has(mark)) throw new Error(`Unsupported mark type: ${mark}`)
    return mark
  }
  if (mark && typeof mark === "object" && !Array.isArray(mark)) {
    const obj = mark as Record<string, unknown>
    for (const key of Object.keys(obj)) {
      if (!ALLOWED_MARK_KEYS.has(key)) throw new Error(`Property "${key}" is forbidden in mark definition`)
    }
    if (typeof obj.type !== "string" || !ALLOWED_MARKS.has(obj.type))
      throw new Error(`Unsupported mark type: ${String(obj.type)}`)
    // 半径只接受有界数值，拒绝 Vega-Lite 的表达式对象进入编译器。
    if (
      "innerRadius" in obj &&
      (typeof obj.innerRadius !== "number" ||
        !Number.isFinite(obj.innerRadius) ||
        obj.innerRadius < 0 ||
        obj.innerRadius > 200)
    ) {
      throw new Error("Mark innerRadius must be between 0 and 200")
    }
    if (
      "outerRadius" in obj &&
      (typeof obj.outerRadius !== "number" ||
        !Number.isFinite(obj.outerRadius) ||
        obj.outerRadius < 0 ||
        obj.outerRadius > 320)
    ) {
      throw new Error("Mark outerRadius must be between 0 and 320")
    }
    if ("point" in obj && typeof obj.point !== "boolean") throw new Error("Mark point must be a boolean")
    return obj
  }
  throw new Error("Mark must be a string or mark definition object")
}

function validateScale(scale: unknown): Record<string, unknown> | null {
  if (scale === null) return null
  if (!scale || typeof scale !== "object" || Array.isArray(scale)) throw new Error("Scale must be an object or null")
  const obj = scale as Record<string, unknown>
  for (const k of Object.keys(obj)) {
    if (!ALLOWED_SCALE_KEYS.has(k)) throw new Error(`Property "${k}" is forbidden in scale definition`)
  }
  if ("type" in obj && typeof obj.type !== "string") throw new Error("Scale type must be a string")
  if ("zero" in obj && typeof obj.zero !== "boolean") throw new Error("Scale zero must be a boolean")
  if ("reverse" in obj && typeof obj.reverse !== "boolean") throw new Error("Scale reverse must be a boolean")
  if ("domain" in obj) {
    if (!Array.isArray(obj.domain)) throw new Error("Scale domain must be an array")
    if (obj.domain.length > MAX_TOTAL_ROWS) throw new Error("Scale domain exceeds maximum limit")
    for (const d of obj.domain) {
      if (typeof d === "number" && !Number.isFinite(d)) throw new Error("Scale domain contains non-finite numbers")
      if (typeof d !== "string" && typeof d !== "number" && typeof d !== "boolean")
        throw new Error("Scale domain items must be primitive")
    }
  }
  return obj
}

function validateSort(sort: unknown): unknown {
  if (sort === null || typeof sort === "string" || typeof sort === "boolean") return sort
  if (Array.isArray(sort)) {
    for (const s of sort) {
      if (typeof s === "number" && !Number.isFinite(s)) throw new Error("Sort array contains non-finite numbers")
      if (typeof s !== "string" && typeof s !== "number") throw new Error("Sort array items must be strings or numbers")
    }
    return sort
  }
  if (sort && typeof sort === "object") {
    const obj = sort as Record<string, unknown>
    for (const k of Object.keys(obj)) {
      if (k !== "field" && k !== "op" && k !== "order")
        throw new Error(`Property "${k}" is forbidden in sort definition`)
    }
    if (typeof obj.field !== "string") throw new Error("Sort field must be a string")
    if ("op" in obj && typeof obj.op !== "string") throw new Error("Sort op must be a string")
    if ("order" in obj && obj.order !== "ascending" && obj.order !== "descending")
      throw new Error('Sort order must be "ascending" or "descending"')
    return obj
  }
  throw new Error("Invalid sort specification")
}

function validateGuide(guide: unknown, isAxis: boolean): Record<string, unknown> | null {
  if (guide === null) return null
  if (!guide || typeof guide !== "object" || Array.isArray(guide)) throw new Error("Guide must be an object")
  const obj = guide as Record<string, unknown>
  const allowed = isAxis ? ALLOWED_AXIS_KEYS : ALLOWED_LEGEND_KEYS
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) throw new Error(`Custom ${isAxis ? "axis" : "legend"} styling property "${k}" is forbidden`)
  }
  if ("title" in obj && obj.title !== null && typeof obj.title !== "string")
    throw new Error("Guide title must be a string or null")
  if ("format" in obj && typeof obj.format !== "string") throw new Error("Guide format must be a string")
  if ("formatType" in obj && (typeof obj.formatType !== "string" || !ALLOWED_FORMAT_TYPES.has(obj.formatType))) {
    throw new Error('Guide formatType must be "number" or "time"')
  }
  if ("orient" in obj && (typeof obj.orient !== "string" || !ALLOWED_ORIENTS.has(obj.orient)))
    throw new Error("Invalid guide orient")
  if (
    "tickCount" in obj &&
    (typeof obj.tickCount !== "number" || !Number.isInteger(obj.tickCount) || obj.tickCount <= 0 || obj.tickCount > 100)
  ) {
    throw new Error("Guide tickCount must be an integer between 1 and 100")
  }
  if ("values" in obj) {
    if (!Array.isArray(obj.values) || obj.values.length > 1000)
      throw new Error("Guide values must be an array <= 1000 items")
    for (const v of obj.values) {
      if (typeof v !== "string" && (typeof v !== "number" || !Number.isFinite(v)))
        throw new Error("Guide values must be finite primitives")
    }
  }
  if (isAxis) {
    if ("labels" in obj && typeof obj.labels !== "boolean") throw new Error("Axis labels must be a boolean")
    if ("ticks" in obj && typeof obj.ticks !== "boolean") throw new Error("Axis ticks must be a boolean")
    if ("grid" in obj && typeof obj.grid !== "boolean") throw new Error("Axis grid must be a boolean")
  }
  return obj
}

function validateEncoding(encoding: unknown): Record<string, unknown> {
  if (!encoding || typeof encoding !== "object" || Array.isArray(encoding))
    throw new Error("Encoding must be an object")
  const enc = encoding as Record<string, unknown>
  for (const [channel, def] of Object.entries(enc)) {
    if (!ALLOWED_CHANNELS.has(channel)) throw new Error(`Unsupported encoding channel: ${channel}`)
    if (!def || typeof def !== "object" || Array.isArray(def))
      throw new Error(`Channel definition for "${channel}" must be an object`)
    const channelDef = def as Record<string, unknown>
    if (channel === "color" && "value" in channelDef)
      throw new Error("Custom color values in color channel are forbidden")
    // 关闭颜色映射会将数据字段当成 CSS 颜色，绕过宿主配色。
    if (
      channel === "color" &&
      (channelDef.scale === null || (channelDef.scale as Record<string, unknown> | undefined)?.type === "identity")
    ) {
      throw new Error("Color encoding must use a host-controlled scale")
    }
    for (const [k, v] of Object.entries(channelDef)) {
      if (!ALLOWED_CHANNEL_KEYS.has(k)) throw new Error(`Forbidden property "${k}" in encoding channel "${channel}"`)
      if (
        k === "value" &&
        typeof v !== "string" &&
        typeof v !== "boolean" &&
        (typeof v !== "number" || !Number.isFinite(v))
      ) {
        throw new Error(`Channel "${channel}" value must be a primitive scalar`)
      }
      if (
        (k === "field" || k === "type" || k === "aggregate" || k === "timeUnit" || k === "format") &&
        typeof v !== "string"
      ) {
        throw new Error(`Channel "${channel}" property "${k}" must be a string`)
      }
      if (k === "title" && v !== null && typeof v !== "string")
        throw new Error(`Channel "${channel}" title must be a string or null`)
      if (k === "stack" && v !== null && typeof v !== "boolean" && typeof v !== "string")
        throw new Error(`Channel "${channel}" stack must be string or boolean`)
      if (k === "band" && (typeof v !== "number" || !Number.isFinite(v)))
        throw new Error(`Channel "${channel}" band must be a finite number`)
      if (k === "bin") {
        if (typeof v === "boolean") continue
        if (!v || typeof v !== "object" || Array.isArray(v))
          throw new Error(`Invalid bin specification in channel "${channel}"`)
        const binObj = v as Record<string, unknown>
        for (const bk of Object.keys(binObj))
          if (bk !== "maxbins") throw new Error(`Property "${bk}" is forbidden in bin definition`)
        if (
          typeof binObj.maxbins !== "number" ||
          !Number.isInteger(binObj.maxbins) ||
          binObj.maxbins <= 0 ||
          binObj.maxbins > 100
        ) {
          throw new Error("Bin maxbins must be an integer between 1 and 100")
        }
      } else if (k === "scale") {
        validateScale(v)
      } else if (k === "sort") {
        validateSort(v)
      } else if (k === "axis") {
        validateGuide(v, true)
      } else if (k === "legend") {
        validateGuide(v, false)
      }
    }
  }
  return enc
}

function validateLayer(
  layers: unknown,
  rootValues: Record<string, unknown>[],
): { layers: Record<string, unknown>[]; totalRows: number } {
  if (!Array.isArray(layers) || layers.length === 0) throw new Error("Layer must be a non-empty array")
  if (layers.length > MAX_LAYERS) throw new Error(`Layers exceed maximum limit of ${MAX_LAYERS}`)
  let layerRows = 0
  const cleanLayers = layers.map((layer, index) => {
    if (!layer || typeof layer !== "object" || Array.isArray(layer)) throw new Error(`Layer ${index} must be an object`)
    const l = layer as Record<string, unknown>
    for (const k of Object.keys(l)) {
      if (!ALLOWED_LAYER_KEYS.has(k)) throw new Error(`Property "${k}" is forbidden in layer ${index}`)
    }
    if (!("mark" in l)) throw new Error(`Layer ${index} missing required mark`)
    let layerValues = rootValues
    if ("data" in l) {
      layerValues = validateData(l.data)
      layerRows += layerValues.length
    }
    const cleanLayer: Record<string, unknown> = {
      mark: validateMark(l.mark),
      data: { values: layerValues },
    }
    if ("encoding" in l) cleanLayer.encoding = validateEncoding(l.encoding)
    return cleanLayer
  })
  return { layers: cleanLayers, totalRows: layerRows }
}

function buildSanitizedSpec(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Chart specification must be an object")
  checkDepth(raw)
  const spec = raw as Record<string, unknown>
  for (const k of Object.keys(spec)) {
    if (!ALLOWED_ROOT_KEYS.has(k)) throw new Error(`Property "${k}" is forbidden in chart specification`)
  }
  if (!("data" in spec)) throw new Error("Root data property with values array is required")
  const rootValues = validateData(spec.data)

  const cleanSpec: Record<string, unknown> = {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    data: { values: rootValues },
    width: CHART_WIDTH,
    height: CHART_HEIGHT,
    autosize: { type: "fit", contains: "padding" },
  }

  if (typeof spec.title === "string") {
    cleanSpec.title = spec.title
  } else if (spec.title && typeof spec.title === "object" && !Array.isArray(spec.title)) {
    const t = spec.title as Record<string, unknown>
    if (typeof t.text === "string") cleanSpec.title = { text: t.text }
  }
  if (typeof spec.description === "string") cleanSpec.description = spec.description

  // 支持并校验共享根 encoding
  if ("encoding" in spec) cleanSpec.encoding = validateEncoding(spec.encoding)

  let totalRows = rootValues.length
  if ("layer" in spec) {
    const layerResult = validateLayer(spec.layer, rootValues)
    totalRows += layerResult.totalRows
    cleanSpec.layer = layerResult.layers
    // 分类柱图叠加单一参考值时，参考值显示为横跨柱宽的短刻度；区间线、全局阈值不改写。
    const rootEncoding = cleanSpec.encoding as Record<string, Record<string, unknown>> | undefined
    for (const layer of layerResult.layers) {
      const mark = layer.mark
      if (
        mark !== "rule" &&
        (typeof mark !== "object" || mark === null || (mark as Record<string, unknown>).type !== "rule")
      )
        continue
      const encoding = { ...rootEncoding, ...(layer.encoding as Record<string, Record<string, unknown>> | undefined) }
      if (Object.keys(encoding).some((key) => !["x", "y"].includes(key))) continue
      const horizontal = encoding.x?.type === "quantitative"
      const categoryChannel = horizontal ? "y" : "x"
      const measureChannel = horizontal ? "x" : "y"
      const category = encoding[categoryChannel]
      const measure = encoding[measureChannel]
      if (
        !category ||
        !measure ||
        typeof category.field !== "string" ||
        typeof measure.field !== "string" ||
        !["nominal", "ordinal"].includes(String(category.type)) ||
        measure.type !== "quantitative" ||
        category.aggregate ||
        category.bin ||
        category.timeUnit ||
        category.scale === null ||
        measure.aggregate ||
        measure.bin ||
        measure.timeUnit ||
        measure.scale === null
      )
        continue
      const field = category.field
      const values = (layer.data as { values: Record<string, unknown>[] }).values
      if (values.length === 0 || new Set(values.map((row) => row[field])).size !== values.length) continue
      const bar = layerResult.layers.find((candidate) => {
        const mark = candidate.mark
        if (
          mark !== "bar" &&
          (typeof mark !== "object" || mark === null || (mark as Record<string, unknown>).type !== "bar")
        )
          return false
        const barEncoding = {
          ...rootEncoding,
          ...(candidate.encoding as Record<string, Record<string, unknown>> | undefined),
        }
        return (
          Object.keys(barEncoding).every((key) => ["x", "y"].includes(key)) &&
          barEncoding[categoryChannel]?.field === field &&
          barEncoding[categoryChannel]?.type === category.type &&
          barEncoding[measureChannel]?.type === "quantitative"
        )
      })
      if (!bar) continue
      layer.mark = {
        type: "tick",
        orient: horizontal ? "vertical" : "horizontal",
        size: 26,
        thickness: 2,
        color: "#929292",
      }
    }
  } else {
    if (!("mark" in spec)) throw new Error("Specification must define either mark or layer")
    const mark = validateMark(spec.mark)
    cleanSpec.mark = mark
    // 独立饼/环图采用紧凑正方形；显式外半径保留原尺寸，避免裁切用户指定的几何大小。
    // 当前由宿主统一普通饼/环图的显示半径，仅保留是否有内孔的语义；数据编码的半径和多层图不改写。
    const encoding = cleanSpec.encoding as Record<string, Record<string, unknown>> | undefined
    if ((mark === "arc" || (typeof mark === "object" && mark.type === "arc")) && !encoding?.radius) {
      cleanSpec.width = 320
      cleanSpec.height = 250
      cleanSpec.autosize = { type: "pad", contains: "padding" }
      cleanSpec.mark = {
        ...(typeof mark === "object" ? mark : { type: mark }),
        outerRadius: 100,
        innerRadius: typeof mark === "object" && typeof mark.innerRadius === "number" && mark.innerRadius > 0 ? 62 : 0,
      }
    }
    // 仅为少量、未聚合且一分类一数值的简单图补标签；分组、堆叠、负值和分箱仍交由原编码表达。
    const type = typeof mark === "string" ? mark : mark.type
    // 散点保留数值域，增加顶部余量和标记周围空间；只减弱网格，不截断坐标以制造趋势。
    if (["point", "circle", "square"].includes(String(type)) && encoding) {
      cleanSpec.height = 260
      cleanSpec.padding = { top: 14, right: 16, bottom: 8, left: 8 }
      cleanSpec.encoding = Object.fromEntries(
        Object.entries(encoding).map(([channel, def]) => {
          if ((channel !== "x" && channel !== "y") || def.axis === null) return [channel, def]
          return [
            channel,
            {
              ...def,
              axis: {
                grid: channel === "y",
                gridOpacity: 0.45,
                tickCount: 4,
                ...(def.axis as Record<string, unknown> | undefined),
              },
            },
          ]
        }),
      )
    }
    // 分类刻度图按组数分配空间，不让少量观测占满默认画布；不改变数值轴范围或样本位置。
    if (type === "tick" && encoding) {
      const categoryChannel = encoding.x?.type === "quantitative" ? "y" : "x"
      const valueChannel = categoryChannel === "y" ? "x" : "y"
      const value = encoding[valueChannel]
      if (value?.type === "quantitative" && value.axis !== null) {
        cleanSpec.encoding = {
          ...encoding,
          [valueChannel]: {
            ...value,
            axis: { gridOpacity: 0.35, ...(value.axis as Record<string, unknown> | undefined) },
          },
        }
      }
      const category = encoding[categoryChannel]
      if (
        category &&
        (category.type === "nominal" || category.type === "ordinal") &&
        typeof category.field === "string"
      ) {
        const field = category.field
        const count = new Set(rootValues.map((row) => row[field])).size
        if (count > 0 && count <= 12) {
          cleanSpec[categoryChannel === "y" ? "height" : "width"] = Math.max(96, count * 48)
          cleanSpec.autosize = { type: "pad", contains: "padding" }
        }
        // 颜色仅重复类别轴时无需再解释一次；显式图例与独立颜色映射仍保留。
        if (
          encoding.color?.field === field &&
          encoding.color.type === category.type &&
          !("legend" in encoding.color) &&
          !("scale" in encoding.color)
        ) {
          cleanSpec.encoding = {
            ...(cleanSpec.encoding as Record<string, unknown>),
            color: { ...encoding.color, legend: null },
          }
        }
      }
    }
    // 纯分类文字矩阵按单元格排版，不沿用数值图的固定大画布；连续坐标与组合标注不受影响。
    if (
      (type === "text" || type === "rect") &&
      encoding &&
      rootValues.length > 0 &&
      ["x", "y"].every((channel) => {
        const def = encoding[channel]
        return (
          def &&
          typeof def.field === "string" &&
          (def.type === "nominal" || def.type === "ordinal") &&
          def.scale !== null &&
          !def.aggregate &&
          !def.bin &&
          !def.timeUnit
        )
      })
    ) {
      const xField = encoding.x!.field as string
      const yField = encoding.y!.field as string
      const columns = new Set(rootValues.map((row) => row[xField])).size
      const rows = new Set(rootValues.map((row) => row[yField])).size
      if (columns <= 12 && rows <= 30) {
        cleanSpec.width = Math.max(160, Math.min(CHART_WIDTH, columns * 104))
        cleanSpec.height = Math.max(40, rows * 40)
        cleanSpec.autosize = { type: "pad", contains: "padding" }
        if (type === "text") cleanSpec.mark = { type: "text", align: "center", baseline: "middle" }
        cleanSpec.encoding = {
          ...encoding,
          x: {
            ...encoding.x,
            axis:
              encoding.x!.axis === null
                ? null
                : {
                    labelAngle: 0,
                    labelOverlap: true,
                    labelLimit: 100,
                    ...(encoding.x!.axis as Record<string, unknown> | undefined),
                  },
          },
        }
        // 小型、无聚合且单元格唯一的数值热图直接标数；特殊色标和组合图不推测对比色。
        const color = encoding.color
        const valueField = color?.field
        if (
          type === "rect" &&
          color?.type === "quantitative" &&
          typeof valueField === "string" &&
          !color.aggregate &&
          !color.bin &&
          !color.scale &&
          !encoding.text &&
          rootValues.length <= 60 &&
          rootValues.every((row) => typeof row[valueField] === "number") &&
          new Set(rootValues.map((row) => JSON.stringify([row[xField], row[yField]]))).size === rootValues.length
        ) {
          const values = rootValues.map((row) => row[valueField] as number)
          cleanSpec.layer = [
            { mark: cleanSpec.mark },
            {
              mark: { type: "text", align: "center", baseline: "middle" },
              encoding: {
                text: { field: valueField, type: "quantitative", format: color.format ?? ",~g" },
                color: {
                  condition: {
                    test: { field: valueField, gte: (Math.min(...values) + Math.max(...values)) / 2 },
                    value: "#ffffff",
                  },
                  value: "#171717",
                },
              },
            },
          ]
          delete cleanSpec.mark
        }
      }
    }
    const horizontal = type === "bar" && encoding?.x?.type === "quantitative" && encoding?.y?.type !== "quantitative"
    const category = horizontal ? encoding?.y : encoding?.x
    const measure = horizontal ? encoding?.x : encoding?.y
    const field = measure?.field
    const categoryField = category?.field
    if (
      (type === "bar" || type === "line") &&
      encoding &&
      rootValues.length > 0 &&
      rootValues.length <= 8 &&
      Object.keys(encoding).every((key) => ["x", "y", "text"].includes(key)) &&
      typeof categoryField === "string" &&
      typeof field === "string" &&
      measure?.type === "quantitative" &&
      (category?.type === "nominal" || category?.type === "ordinal") &&
      category.scale !== null &&
      measure.scale !== null &&
      !category?.aggregate &&
      !category?.bin &&
      !category?.timeUnit &&
      !measure.aggregate &&
      !measure.bin &&
      !measure.stack &&
      !measure.timeUnit &&
      rootValues.every((row) => typeof row[field] === "number" && row[field] >= 0) &&
      new Set(rootValues.map((row) => row[categoryField])).size === rootValues.length
    ) {
      cleanSpec.layer = [
        { mark: cleanSpec.mark },
        {
          mark: {
            type: "text",
            dy: horizontal ? 0 : -8,
            dx: horizontal ? 8 : 0,
            align: horizontal ? "left" : "center",
            baseline: horizontal ? "middle" : "bottom",
          },
          encoding: { text: encoding.text ?? { field, type: "quantitative", format: measure.format ?? ",~g" } },
        },
      ]
      cleanSpec.padding = { top: 20, right: horizontal ? 48 : 12, bottom: 5, left: 5 }
      delete cleanSpec.mark
    }
  }

  if (totalRows > MAX_TOTAL_ROWS) {
    throw new Error(`Total data rows across all layers (${totalRows}) exceed maximum limit of ${MAX_TOTAL_ROWS}`)
  }

  return cleanSpec
}

export async function renderCanvasChart(source: string, theme?: CanvasChartTheme): Promise<string> {
  if (typeof source !== "string") throw new Error("Chart source must be a string")
  if (new TextEncoder().encode(source).length > MAX_SOURCE_BYTES) {
    throw new Error("Chart source exceeds maximum size limit of 256 KiB")
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (err) {
    throw new Error(`Chart specification is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }

  const cleanSpec = buildSanitizedSpec(parsed)
  const activeTheme = theme ?? DEFAULT_CANVAS_THEME
  const rows = (cleanSpec.data as { values: Record<string, unknown>[] }).values

  // 构造统一宿主无边框与语义配色配置，为默认 mark 注入主题首选色
  // 克制文档式分析报告：网格极淡、刻度减量、字号收敛、字重不粗重，图表直接落在纸面上
  const config = {
    background: activeTheme.background,
    view: { stroke: null },
    font: activeTheme.font,
    mark: { color: activeTheme.colors[0] },
    title: {
      color: activeTheme.text,
      font: activeTheme.font,
      fontSize: CANVAS_GRAPH_STYLE.titleSize,
      fontWeight: 500,
      anchor: "start",
      offset: 16,
    },
    axis: {
      domain: false,
      ticks: false,
      grid: false,
      gridColor: activeTheme.grid,
      gridOpacity: 1,
      gridWidth: 1,
      labelColor: activeTheme.muted,
      labelFont: activeTheme.font,
      labelFontSize: CANVAS_GRAPH_STYLE.labelSize,
      labelFontWeight: 400,
      labelLimit: 0,
      labelPadding: 8,
      tickColor: activeTheme.grid,
      tickSize: 4,
      tickWidth: 1,
      tickCount: 5,
      titleColor: activeTheme.muted,
      titleFont: activeTheme.font,
      titleFontSize: CANVAS_GRAPH_STYLE.labelSize,
      titleFontWeight: 400,
      titlePadding: 8,
    },
    axisQuantitative: {
      grid: true,
      ticks: false,
    },
    axisTemporal: {
      grid: false,
      ticks: false,
    },
    axisBand: {
      grid: false,
      ticks: false,
      labelPadding: 6,
    },
    // 分类名称保持正常阅读方向；密集标签避让而不是默认旋转成竖排。
    axisX: {
      labelAngle: 0,
      labelOverlap: true,
      labelLimit: 120,
    },
    legend: {
      title: null,
      orient: "bottom",
      direction: "horizontal",
      offset: 16,
      columns: 3,
      columnPadding: 16,
      rowPadding: 8,
      labelColor: activeTheme.text,
      labelFont: activeTheme.font,
      labelFontSize: 12,
      labelLimit: 0,
      titleColor: activeTheme.muted,
      titleFont: activeTheme.font,
      titleFontSize: CANVAS_GRAPH_STYLE.labelSize,
      titleFontWeight: 400,
      symbolSize: 64,
      symbolType: "square",
      layout: { bottom: { anchor: "middle" } },
      symbolStrokeWidth: CANVAS_GRAPH_STYLE.lineWidth,
      padding: 0,
    },
    // 少量端点与清晰线条形成图形特征，不使用大圆角、描边面板或装饰渐变。
    line: {
      strokeWidth: CANVAS_GRAPH_STYLE.lineWidth,
      strokeCap: "round",
      strokeJoin: "round",
      interpolate: "monotone",
      point: rows.length <= 24 ? { filled: true, size: 28 } : false,
    },
    area: { interpolate: "monotone", fillOpacity: 0.35, line: { strokeWidth: 1.5 }, point: false },
    point: { filled: true, size: 88, opacity: 0.95, stroke: activeTheme.background, strokeWidth: 1 },
    circle: { size: 88, opacity: 0.95, stroke: activeTheme.background, strokeWidth: 1 },
    square: { size: 72, opacity: 0.95, stroke: activeTheme.background, strokeWidth: 1 },
    tick: { thickness: CANVAS_GRAPH_STYLE.lineWidth, size: 16 },
    rule: { strokeWidth: CANVAS_GRAPH_STYLE.strokeWidth, color: activeTheme.muted },
    rect: { stroke: activeTheme.background, strokeWidth: 1 },
    bar: { binSpacing: 2, discreteBandSize: { band: 0.7 }, continuousBandSize: 18, cornerRadiusEnd: 2 },
    arc: { strokeWidth: 0 },
    text: { color: activeTheme.text, font: activeTheme.font, fontSize: CANVAS_GRAPH_STYLE.labelSize },
    range: {
      category: activeTheme.colors,
      // 连续数值使用有序明暗色阶，不能循环类别色板而误导数值大小。
      heatmap: [activeTheme.colors[0], activeTheme.colors[activeTheme.colors.length - 1]],
      ramp: activeTheme.ramp ?? [activeTheme.colors[0], activeTheme.colors[activeTheme.colors.length - 1]],
    },
  } satisfies Config

  const [{ compile }, { parse, View }, { expressionInterpreter }] = await Promise.all([
    import("vega-lite"),
    import("vega"),
    import("vega-interpreter"),
  ])

  const compiled = compile(cleanSpec as TopLevelSpec, { config })

  // 严格在 AST 模式下解析 Vega 规范，禁止 eval 生成代码
  const runtime = parse(compiled.spec, undefined, { ast: true })

  // 使用受限 Loader 与 CSP 表达式解释器实例化 Headless View
  const view = new View(runtime, {
    expr: expressionInterpreter,
    renderer: "none",
    loader: SAFE_LOADER,
  })

  try {
    await view.runAsync()
    return await view.toSVG()
  } finally {
    view.finalize()
  }
}
