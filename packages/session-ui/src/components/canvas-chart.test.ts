import { describe, expect, it } from "bun:test"
import { renderCanvasChart } from "./canvas-chart"
import { createCanvasTheme, CANVAS_GRAPH_STYLE, type CanvasChartTheme } from "./canvas-theme"

describe("renderCanvasChart", () => {
  it("uses a compact canvas for default donut geometry without losing categories", async () => {
    const data = {
      values: [
        { segment: "Direct", share: 40 },
        { segment: "Partner", share: 60 },
      ],
    }
    const donut = await renderCanvasChart(
      JSON.stringify({
        data,
        mark: { type: "arc", innerRadius: 60 },
        encoding: {
          theta: { field: "share", type: "quantitative" },
          color: { field: "segment", type: "nominal" },
        },
      }),
    )
    const bar = await renderCanvasChart(
      JSON.stringify({
        data,
        mark: "bar",
        encoding: {
          x: { field: "segment", type: "nominal" },
          y: { field: "share", type: "quantitative" },
        },
      }),
    )
    const oversized = await renderCanvasChart(
      JSON.stringify({
        data,
        mark: { type: "arc", innerRadius: 130, outerRadius: 200 },
        encoding: {
          theta: { field: "share", type: "quantitative" },
          color: { field: "segment", type: "nominal" },
        },
      }),
    )
    expect(Number(donut.match(/<svg\b[^>]*\bwidth="([^"]+)"/)?.[1])).toBeLessThan(
      Number(bar.match(/<svg\b[^>]*\bwidth="([^"]+)"/)?.[1]),
    )
    expect(donut).toMatch(/aria-label="(?=[^"]*Direct)(?=[^"]*40)[^"]*"/)
    expect(donut).toMatch(/aria-label="(?=[^"]*Partner)(?=[^"]*60)[^"]*"/)
    // 模型传入过大的半径不再改变展示比例，仍保留环图而不是降级成实心饼图。
    expect(Array.from(oversized.matchAll(/<path\b[^>]*\sd="([^"]+)"/g), (match) => match[1])).toEqual(
      Array.from(donut.matchAll(/<path\b[^>]*\sd="([^"]+)"/g), (match) => match[1]),
    )
  })

  it.each([false, true])("renders series with the shared canvas palette and label scale (dark: %s)", async (dark) => {
    const theme = createCanvasTheme(dark)
    const svg = await renderCanvasChart(
      JSON.stringify({
        data: {
          values: [
            { channel: "Direct", orders: 12 },
            { channel: "Partner", orders: 23 },
          ],
        },
        mark: "bar",
        encoding: {
          x: { field: "channel", type: "nominal" },
          y: { field: "orders", type: "quantitative" },
          color: { field: "channel", type: "nominal" },
        },
      }),
      theme,
    )
    expect(svg).toContain(`fill="${theme.colors[0]}"`)
    expect(svg).toContain(`fill="${theme.colors[1]}"`)
    expect(svg).toContain(`fill="${theme.muted}"`)
    expect(svg).toMatch(new RegExp(`font-size="${CANVAS_GRAPH_STYLE.labelSize}(?:px)?"`))
    expect(svg).toMatch(/aria-label="[^"]*Direct[^\"]*12[^\"]*"/)
    expect(svg).toMatch(/aria-label="[^"]*Partner[^\"]*23[^\"]*"/)
  })

  it("renders a standard bar chart with data labels and visual marks", async () => {
    const spec = JSON.stringify({
      data: {
        values: [
          { category: "Alpha", amount: 28 },
          { category: "Beta", amount: 55 },
        ],
      },
      mark: "bar",
      encoding: {
        x: { field: "category", type: "nominal", axis: { title: "Category" } },
        y: { field: "amount", type: "quantitative", axis: { title: "Amount" } },
      },
    })

    const svg = await renderCanvasChart(spec)
    expect(svg).toContain("<svg")
    expect(svg).toContain("</svg>")
    // 真实断言图表轴标题与业务分类标签均渲染到 SVG 文本节点中
    expect(svg).toContain("Category")
    expect(svg).toContain("Amount")
    expect(svg).toContain("Alpha")
    expect(svg).toContain("Beta")
    expect(svg).toMatch(/aria-label="[^"]*Alpha[^"]*28[^"]*"/)
    expect(svg).toMatch(/aria-label="[^"]*Beta[^"]*55[^"]*"/)
    // 断言存在几何路径标记
    expect(svg).toContain("<path")
  })

  it("renders a grouped bar chart using xOffset channel", async () => {
    const spec = JSON.stringify({
      data: {
        values: [
          { dept: "Eng", role: "Dev", count: 12 },
          { dept: "Eng", role: "QA", count: 5 },
          { dept: "Sales", role: "Dev", count: 2 },
          { dept: "Sales", role: "QA", count: 8 },
        ],
      },
      mark: "bar",
      encoding: {
        x: { field: "dept", type: "nominal" },
        xOffset: { field: "role" },
        y: { field: "count", type: "quantitative" },
        color: { field: "role", type: "nominal" },
      },
    })

    const svg = await renderCanvasChart(spec)
    expect(svg).toContain("Eng")
    expect(svg).toContain("Sales")
    expect(svg).toContain("Dev")
    expect(svg).toContain("QA")
    const stacked = JSON.parse(spec)
    delete stacked.encoding.xOffset
    const stackedSvg = await renderCanvasChart(JSON.stringify(stacked))
    expect(Array.from(svg.matchAll(/<path\b[^>]*\sd="([^"]+)"/g), (match) => match[1])).not.toEqual(
      Array.from(stackedSvg.matchAll(/<path\b[^>]*\sd="([^"]+)"/g), (match) => match[1]),
    )
  })

  it("renders a donut chart with arc mark and innerRadius", async () => {
    const spec = JSON.stringify({
      data: {
        values: [
          { segment: "First", share: 40 },
          { segment: "Second", share: 60 },
        ],
      },
      mark: { type: "arc", innerRadius: 50, outerRadius: 100 },
      encoding: {
        theta: { field: "share", type: "quantitative" },
        color: { field: "segment", type: "nominal" },
      },
    })

    const svg = await renderCanvasChart(spec)
    expect(svg).toContain("First")
    expect(svg).toContain("Second")
    expect(svg).toContain("<path")
    const pie = JSON.parse(spec)
    pie.mark.innerRadius = 0
    const pieSvg = await renderCanvasChart(JSON.stringify(pie))
    expect(Array.from(svg.matchAll(/<path\b[^>]*\sd="([^"]+)"/g), (match) => match[1])).not.toEqual(
      Array.from(pieSvg.matchAll(/<path\b[^>]*\sd="([^"]+)"/g), (match) => match[1]),
    )
  })

  it("renders a line chart with point markers enabled", async () => {
    const spec = JSON.stringify({
      data: {
        values: [
          { time: "2026-01-01", score: 10 },
          { time: "2026-01-02", score: 25 },
        ],
      },
      mark: { type: "line", point: true },
      encoding: {
        x: { field: "time", type: "nominal" },
        y: { field: "score", type: "quantitative" },
      },
    })

    const svg = await renderCanvasChart(spec)
    expect(svg).toContain("2026-01-01")
    expect(svg).toContain("2026-01-02")
    expect(svg).toContain("<path")
    const line = JSON.parse(spec)
    line.mark.point = false
    const lineSvg = await renderCanvasChart(JSON.stringify(line))
    expect(Array.from(svg.matchAll(/<path\b/g)).length).toBeGreaterThan(Array.from(lineSvg.matchAll(/<path\b/g)).length)
  })

  it("renders a layered chart inheriting root data and shared encoding", async () => {
    const spec = JSON.stringify({
      data: {
        values: [
          { group: "X", value: 12 },
          { group: "Y", value: 24 },
        ],
      },
      encoding: {
        x: { field: "group", type: "nominal" },
      },
      layer: [
        {
          mark: "bar",
          encoding: {
            y: { field: "value", type: "quantitative" },
          },
        },
        {
          mark: "rule",
          encoding: {
            x: { value: 0 },
            y: { aggregate: "mean", field: "value", type: "quantitative" },
          },
        },
      ],
    })

    const svg = await renderCanvasChart(spec)
    expect(svg).toContain("X")
    expect(svg).toContain("Y")
    expect(svg).toContain("<path")
    expect(svg).toMatch(/aria-label="[^"]*18[^"]*"/)
  })

  it("allows channel scale: null to disable scale domain", async () => {
    const spec = JSON.stringify({
      data: {
        values: [{ category: "A", val: 10 }],
      },
      mark: "bar",
      encoding: {
        x: { field: "category", type: "nominal" },
        y: { field: "val", type: "quantitative", scale: null },
      },
    })

    const svg = await renderCanvasChart(spec)
    expect(svg).toContain("A")
    const scaled = JSON.parse(spec)
    delete scaled.encoding.y.scale
    const scaledSvg = await renderCanvasChart(JSON.stringify(scaled))
    expect(Array.from(svg.matchAll(/<path\b[^>]*\sd="([^"]+)"/g), (match) => match[1])).not.toEqual(
      Array.from(scaledSvg.matchAll(/<path\b[^>]*\sd="([^"]+)"/g), (match) => match[1]),
    )
  })

  it("applies custom host theme and default mark color", async () => {
    const theme: CanvasChartTheme = {
      background: "#0f172a",
      text: "#f8fafc",
      muted: "#94a3b8",
      grid: "#334155",
      font: "InterCustom, sans-serif",
      colors: ["#38bdf8", "#4ade80"],
    }

    const spec = JSON.stringify({
      data: {
        values: [{ name: "Demo", val: 5 }],
      },
      mark: "bar",
      encoding: {
        x: { field: "name", type: "nominal" },
        y: { field: "val", type: "quantitative" },
      },
    })

    const svg = await renderCanvasChart(spec, theme)
    // 验证自定义背景、字体以及默认 mark 采用 theme.colors[0] 配色
    expect(svg).toContain("#0f172a")
    expect(svg).toContain("InterCustom")
    expect(svg).toContain("#38bdf8")
  })

  it("rejects invalid JSON", async () => {
    await expect(renderCanvasChart("not-a-json")).rejects.toThrow("Chart specification is not valid JSON")
  })

  it("rejects custom color in mark definition", async () => {
    const spec = JSON.stringify({
      data: { values: [{ x: 1, y: 2 }] },
      mark: { type: "bar", color: "#ff0000" },
      encoding: {
        x: { field: "x", type: "nominal" },
        y: { field: "y", type: "quantitative" },
      },
    })
    await expect(renderCanvasChart(spec)).rejects.toThrow('Property "color" is forbidden in mark definition')
  })

  it("rejects custom color value in color encoding channel", async () => {
    const spec = JSON.stringify({
      data: { values: [{ x: 1, y: 2 }] },
      mark: "bar",
      encoding: {
        x: { field: "x", type: "nominal" },
        y: { field: "y", type: "quantitative" },
        color: { value: "red" },
      },
    })
    await expect(renderCanvasChart(spec)).rejects.toThrow("Custom color values in color channel are forbidden")
  })

  it("rejects custom scale range or scheme to prevent model color override", async () => {
    const spec1 = JSON.stringify({
      data: { values: [{ x: 1, y: 2 }] },
      mark: "bar",
      encoding: {
        x: { field: "x", type: "nominal" },
        y: { field: "y", type: "quantitative", scale: { range: ["red", "blue"] } },
      },
    })
    await expect(renderCanvasChart(spec1)).rejects.toThrow('Property "range" is forbidden in scale definition')

    const spec2 = JSON.stringify({
      data: { values: [{ x: 1, y: 2 }] },
      mark: "bar",
      encoding: {
        x: { field: "x", type: "nominal" },
        y: { field: "y", type: "quantitative", scale: { scheme: "category10" } },
      },
    })
    await expect(renderCanvasChart(spec2)).rejects.toThrow('Property "scheme" is forbidden in scale definition')
  })

  it("rejects using data values directly as colors", async () => {
    for (const scale of [null, { type: "identity" }]) {
      await expect(
        renderCanvasChart(
          JSON.stringify({
            data: { values: [{ category: "red", amount: 2 }] },
            mark: "bar",
            encoding: { color: { field: "category", type: "nominal", scale } },
          }),
        ),
      ).rejects.toThrow("host-controlled scale")
    }
  })

  it("rejects expressions and nonnumeric arc radii", async () => {
    for (const key of ["innerRadius", "outerRadius"]) {
      for (const value of [{ expr: "100" }, "100", null]) {
        await expect(
          renderCanvasChart(
            JSON.stringify({
              data: { values: [{ share: 1 }] },
              mark: { type: "arc", [key]: value },
            }),
          ),
        ).rejects.toThrow(key)
      }
    }
  })

  it("preserves ordinary data columns named like restricted properties", async () => {
    const svg = await renderCanvasChart(
      JSON.stringify({
        data: { values: [{ url: "Local category", expr: 7 }] },
        mark: "bar",
        encoding: {
          x: { field: "url", type: "nominal" },
          y: { field: "expr", type: "quantitative" },
        },
      }),
    )
    expect(svg).toMatch(/aria-label="[^"]*Local category[^"]*7[^"]*"/)
  })

  it("rejects scale domainRaw with arbitrary expressions", async () => {
    const spec = JSON.stringify({
      data: { values: [{ x: 1, y: 2 }] },
      mark: "bar",
      encoding: {
        x: { field: "x", type: "nominal" },
        y: { field: "y", type: "quantitative", scale: { domainRaw: { expr: "datum.x" } } },
      },
    })
    await expect(renderCanvasChart(spec)).rejects.toThrow('Property "domainRaw" is forbidden in scale definition')
  })

  it("rejects bin step bypass and only allows maxbins", async () => {
    const spec = JSON.stringify({
      data: { values: [{ x: 1, y: 2 }] },
      mark: "bar",
      encoding: {
        x: { field: "x", type: "quantitative", bin: { step: 1e-99 } },
        y: { field: "y", type: "quantitative" },
      },
    })
    await expect(renderCanvasChart(spec)).rejects.toThrow('Property "step" is forbidden in bin definition')
  })

  it("rejects innerRadius exceeding 200", async () => {
    const spec = JSON.stringify({
      data: { values: [{ share: 1 }] },
      mark: { type: "arc", innerRadius: 250 },
    })
    await expect(renderCanvasChart(spec)).rejects.toThrow("innerRadius must be between 0 and 200")
  })

  it("rejects transform inside layer rather than silently dropping it", async () => {
    const spec = JSON.stringify({
      data: { values: [{ a: 1 }] },
      layer: [
        {
          mark: "bar",
          transform: [{ calculate: "datum.a * 2", as: "b" }],
        },
      ],
    })
    await expect(renderCanvasChart(spec)).rejects.toThrow('Property "transform" is forbidden in layer 0')
  })

  it("rejects total data rows exceeding 10000 across root and layers", async () => {
    const rows = Array.from({ length: 6000 }, (_, i) => ({ id: i, val: i }))
    const spec = JSON.stringify({
      data: { values: rows },
      layer: [
        {
          mark: "bar",
          data: { values: rows },
        },
      ],
    })
    await expect(renderCanvasChart(spec)).rejects.toThrow("exceed maximum limit of 10000")
  })

  it("rejects nested layers within a layer", async () => {
    const spec = JSON.stringify({
      data: { values: [{ a: 1 }] },
      layer: [
        {
          mark: "bar",
          layer: [{ mark: "line" }],
        },
      ],
    })
    await expect(renderCanvasChart(spec)).rejects.toThrow('Property "layer" is forbidden in layer 0')
  })

  it("rejects custom style properties on axis", async () => {
    const spec = JSON.stringify({
      data: { values: [{ a: 1, b: 2 }] },
      mark: "bar",
      encoding: {
        x: { field: "a", type: "nominal", axis: { title: "OK", labelColor: "red" } },
        y: { field: "b", type: "quantitative" },
      },
    })
    await expect(renderCanvasChart(spec)).rejects.toThrow('Custom axis styling property "labelColor" is forbidden')
  })

  it("rejects external data URLs and datasets", async () => {
    const spec1 = JSON.stringify({
      data: { url: "https://example.com/data.json" },
      mark: "bar",
    })
    await expect(renderCanvasChart(spec1)).rejects.toThrow('Property "url" is forbidden in data')

    const spec2 = JSON.stringify({
      data: { values: [{ a: 1 }] },
      datasets: { extra: [{ a: 2 }] },
      mark: "bar",
    })
    await expect(renderCanvasChart(spec2)).rejects.toThrow('Property "datasets" is forbidden in chart specification')
  })
})
