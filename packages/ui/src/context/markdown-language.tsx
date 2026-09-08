import { bundledLanguages, type BundledLanguage } from "shiki"

export function markdownLanguage(language?: string): BundledLanguage | "text" {
  const name = language?.toLowerCase() === "vega-lite" ? "json" : language?.toLowerCase()
  return name && name in bundledLanguages ? (name as BundledLanguage) : "text"
}

export const markdownLanguages = {
  ...bundledLanguages,
  mermaid: async () => {
    const languages = await bundledLanguages.mermaid()
    // Shiki 的 Mermaid 入口匹配 Markdown 围栏；代码块正文须直接使用内部图表语法。
    return {
      default: languages.default.map((language) =>
        language.name === "mermaid" ? { ...language, patterns: [{ include: "#mermaid" }] } : language,
      ),
    }
  },
}
