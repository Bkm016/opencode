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

  test("renders inline double-dollar LaTeX and colon-preceded LaTeX", async () => {
    const html1 = await createMarkdownParser({}).parse(
      '在 Anthropic Messages 协议下，A6API 却返回：$$\\text{"input_tokens": 68508}, \\quad \\text{"cache_read_input_tokens": 68480}$$',
    )
    expect(html1).toContain('class="katex-display"')
    expect(html1).not.toContain("katex-error")
    expect(html1).not.toContain("$$")

    const html2 = await createMarkdownParser({}).parse(
      '网关被误导：Quark 网关按 Anthropic 官方规范计算总输入：$$\\text{总输入} = \\text{input_tokens (68508)} + \\text{cache_read_input_tokens (68480)} = \\mathbf{136,988}$$ 导致分母被凭空翻倍，原本 99% 的真实命中率被算成了 68480/136988 = 49.98%!',
    )
    expect(html2).toContain('class="katex-display"')
    expect(html2).toContain("导致分母被凭空翻倍")
    expect(html2).not.toContain("katex-error")
    expect(html2).not.toContain("$$")
  })

  test("renders inline single-dollar LaTeX without preceding whitespace", async () => {
    const html = await createMarkdownParser({}).parse("结晶消耗由$128 \\to \\mathbf{64}$,")

    expect(html).toContain('class="katex"')
    expect(html).toContain("<mo>→</mo>")
    expect(html).not.toContain("$128")
  })
})
