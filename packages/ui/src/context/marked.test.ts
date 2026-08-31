import { describe, expect, test } from "bun:test"
import { createMarkdownParser } from "./marked"

describe("Markdown parser", () => {
  test("renders standard inline and display LaTeX", async () => {
    const html = await createMarkdownParser({}).parse(
      "Value $128 \\to \\mathbf{64}$ and \\(a + b\\).\n\n$$\nx^2 + y^2 = z^2\n$$",
    )

    expect(html).toContain('class="katex"')
    expect(html).toContain('class="katex-display"')
    expect(html).toContain("<mo>→</mo>")
    expect(html).not.toContain("$128")
    expect(html).not.toContain("\\(a + b\\)")
  })

  test("renders dollar LaTeX returned by the native Markdown parser", async () => {
    const html = await createMarkdownParser({ nativeParser: async (markdown) => `<p>${markdown}</p>` }).parse(
      "Value $16 \\to \\mathbf{12}$.",
    )

    expect(html).toContain('class="katex"')
    expect(html).toContain("<mo>→</mo>")
    expect(html).not.toContain("$16")
  })

  test("does not render dollar syntax inside code", async () => {
    const html = await createMarkdownParser({}).parse("`$x^2$`")

    expect(html).toContain("$x^2$")
    expect(html).not.toContain('class="katex"')
  })

  test("does not treat separate currency amounts as LaTeX", async () => {
    const html = await createMarkdownParser({}).parse("Costs $5 or $10.")

    expect(html).toContain("Costs $5 or $10.")
    expect(html).not.toContain('class="katex"')
  })
})
