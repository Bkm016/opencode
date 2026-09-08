import { describe, expect, test } from "bun:test"
import { renderCanvas } from "../../session-ui/src/components/canvas-render"
import { renderCanvasChart } from "../../session-ui/src/components/canvas-chart"

describe("canvas document rendering", () => {
  test("tick distributions keep every observation in compact rows without a duplicate legend", async () => {
    const svg = new DOMParser().parseFromString(
      await renderCanvasChart(
        JSON.stringify({
          data: {
            values: [
              { service: "Pay", latency: 68 },
              { service: "Pay", latency: 89 },
              { service: "Query", latency: 32 },
              { service: "Query", latency: 44 },
            ],
          },
          mark: "tick",
          encoding: {
            x: { field: "latency", type: "quantitative" },
            y: { field: "service", type: "nominal" },
            color: { field: "service", type: "nominal" },
          },
        }),
      ),
      "image/svg+xml",
    )
    expect(Number(svg.documentElement.getAttribute("height"))).toBeLessThan(200)
    expect(svg.querySelector(".role-legend")).toBeNull()
    expect(svg.querySelectorAll(".role-mark [aria-label]").length).toBe(4)
    expect(svg.documentElement.textContent).toContain("Pay")
    expect(svg.documentElement.textContent).toContain("Query")
  })

  test("categorical text matrices stay compact with horizontal column labels", async () => {
    const values = ["一组", "二组", "三组"].flatMap((team) => [
      { team, dimension: "交付", rating: "稳定" },
      { team, dimension: "质量", rating: "优秀" },
    ])
    const svg = new DOMParser().parseFromString(
      await renderCanvasChart(
        JSON.stringify({
          data: { values },
          mark: "text",
          encoding: {
            x: { field: "team", type: "nominal", title: "团队" },
            y: { field: "dimension", type: "nominal", title: "评估维度" },
            text: { field: "rating", type: "nominal" },
          },
        }),
      ),
      "image/svg+xml",
    )
    expect(Number(svg.documentElement.getAttribute("height"))).toBeLessThan(180)
    expect(svg.querySelectorAll(".mark-text.role-mark text").length).toBe(6)
    const columns = Array.from(svg.querySelectorAll(".role-axis-label text")).filter((node) =>
      ["一组", "二组", "三组"].includes(node.textContent ?? ""),
    )
    expect(columns.length).toBe(3)
    for (const column of columns) expect(column.getAttribute("transform") ?? "").not.toMatch(/rotate\((?!0(?:[ ,)]))/)
  })

  test("automatic labels only annotate simple categorical values, not stacks or raw coordinates", async () => {
    const data = {
      values: [
        { category: "A", value: 17 },
        { category: "B", value: 29 },
      ],
    }
    for (const scenario of ["simple", "stack", "coordinates", "negative", "duplicate"] as const) {
      const values =
        scenario === "negative"
          ? [{ category: "A", value: -17 }]
          : scenario === "duplicate"
            ? [
                { category: "A", value: 17 },
                { category: "A", value: 29 },
              ]
            : data.values
      const svg = new DOMParser().parseFromString(
        await renderCanvasChart(
          JSON.stringify({
            data: { values },
            mark: "bar",
            encoding: {
              x: { field: "category", type: "nominal" },
              y: { field: "value", type: "quantitative", ...(scenario === "coordinates" ? { scale: null } : {}) },
              ...(scenario === "stack" ? { color: { field: "category", type: "nominal" } } : {}),
            },
          }),
        ),
        "image/svg+xml",
      )
      const labels = Array.from(svg.querySelectorAll(".mark-text.role-mark text"), (node) => node.textContent)
      expect(labels).toEqual(scenario === "simple" ? ["17", "29"] : [])
      expect(svg.querySelectorAll(".mark-rect.role-mark path, .mark-rect.role-mark rect").length).toBeGreaterThan(0)
    }
  })

  test("renders inline chart data as an exportable SVG image alongside Markdown", async () => {
    const source = JSON.stringify({
      data: {
        values: [
          { month: "Jan", revenue: 120 },
          { month: "Feb", revenue: 180 },
        ],
      },
      mark: "bar",
      encoding: {
        x: { field: "month", type: "ordinal" },
        y: { field: "revenue", type: "quantitative", title: "Revenue" },
      },
    })
    const result = await renderCanvas(`# Revenue report\n\n\`\`\`vega-lite\n${source}\n\`\`\`\n\nFebruary grew.`)
    if (!result.ok) throw new Error(result.error)
    const root = document.createElement("div")
    root.innerHTML = result.html
    expect(root.querySelector("h1")?.textContent).toBe("Revenue report")
    expect(root.textContent).toContain("February grew.")
    expect(root.querySelector("pre")).toBeNull()
    const image = root.querySelector("figure img")
    expect(image).not.toBeNull()
    const sourceURL = image!.getAttribute("src")!
    expect(sourceURL.startsWith("data:image/svg+xml,")).toBe(true)
    const svg = new DOMParser().parseFromString(
      decodeURIComponent(sourceURL.slice(sourceURL.indexOf(",") + 1)),
      "image/svg+xml",
    )
    expect(svg.documentElement.localName).toBe("svg")
    expect(svg.querySelector("parsererror")).toBeNull()
    expect(svg.documentElement.textContent).toContain("Revenue")
    expect(svg.documentElement.textContent).toContain("Jan")
    expect(svg.querySelectorAll(".role-axis-domain path, .role-axis-tick line").length).toBe(0)
    expect(svg.querySelectorAll(".role-axis-grid line").length).toBeGreaterThan(0)
    expect(svg.querySelectorAll(".role-axis-label text").length).toBeGreaterThan(0)
    expect(root.querySelector("svg, script")).toBeNull()
  })

  test("a rejected chart fails the document instead of publishing partial content", async () => {
    const result = await renderCanvas(
      '# Heading\n\n```vega-lite\n{"data":{"url":"https://example.com/data.csv"},"mark":"bar"}\n```\n',
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("External chart unexpectedly rendered")
    expect(result.error).toContain("Vega-Lite")
  })

  test("renders standard headings, tables and code as readable content", async () => {
    const result = await renderCanvas(
      "# Request lifecycle\n\n| Step | Owner |\n| --- | --- |\n| Save | Database |\n\n```ts\nconst ready = true\n```\n",
    )
    if (!result.ok) throw new Error(result.error)
    const root = document.createElement("div")
    root.innerHTML = result.html

    expect(root.querySelector("h1")?.textContent).toBe("Request lifecycle")
    expect(Array.from(root.querySelectorAll("tbody td")).map((cell) => cell.textContent)).toEqual(["Save", "Database"])
    expect(root.querySelector("pre code")?.textContent).toContain("const ready = true")
  })

  test("does not allow documents to inject styles, scripts or remote images", async () => {
    const result = await renderCanvas(
      '# Safe content\n\n<style>body{display:none}</style>\n\n<script>alert(1)</script>\n\n<img src="https://example.com/tracker">\n\n![remote](https://example.com/image.png)\n',
    )
    if (!result.ok) throw new Error(result.error)
    const root = document.createElement("div")
    root.innerHTML = result.html

    expect(root.querySelector("h1")?.textContent).toBe("Safe content")
    expect(root.querySelector("style,script,img,iframe,[style],[onclick]")).toBeNull()
  })

  test("external documentation links cannot navigate the OpenCode page", async () => {
    const result = await renderCanvas(
      "[Docs](https://example.com/docs) [Local](/private/file) [Unsafe](javascript:alert%281%29)",
    )
    if (!result.ok) throw new Error(result.error)
    const root = document.createElement("div")
    root.innerHTML = result.html
    const links = root.querySelectorAll("a")

    expect(links.length).toBe(1)
    expect(links[0].getAttribute("href")).toBe("https://example.com/docs")
    expect(links[0].target).toBe("_blank")
    expect(links[0].rel.split(" ")).toContain("noopener")
    expect(root.textContent).toContain("Local")
    expect(root.textContent).toContain("Unsafe")
  })

  test("refuses model-defined diagram styling instead of partially rewriting the diagram", async () => {
    for (const code of [
      '%%{init: {"theme":"dark"}}%%\nflowchart LR\nA --> B',
      "flowchart LR\nA --> B; style A fill:red",
      "flowchart LR\nA --> B\nclassDef red fill:red",
      'flowchart LR\nA --> B\nclick A "https://example.com"',
      "---\nconfig:\n  theme: dark\n---\nflowchart LR\nA --> B",
    ]) {
      const result = await renderCanvas(`\`\`\`mermaid\n${code}\n\`\`\``)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("Forbidden diagram unexpectedly rendered")
      expect(result.error.length).toBeGreaterThan(0)
    }
  })
})
