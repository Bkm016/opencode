// 会话搜索用的取文本与匹配：服务端搜索和前端预览共用，保证两边的位置一致。
// 只依赖结构，不引入 schema，前端打包也轻。

export type FindKind = "text" | "reasoning" | "tool" | "file" | "subtask" | "summary"

type PartLike = {
  type: string
  text?: string
  synthetic?: boolean
  ignored?: boolean
  filename?: string
  prompt?: string
  description?: string
  tool?: string
  state?: { input?: Record<string, unknown>; title?: unknown; output?: unknown; error?: unknown }
}

const TOOL_INPUT_KEYS = ["description", "command", "filePath", "path", "pattern", "include", "url", "query", "prompt"]

const str = (value: unknown) => (typeof value === "string" ? value : "")

export function findPartText(part: PartLike): { kind: FindKind; tool?: string; text: string } | undefined {
  switch (part.type) {
    case "text":
      if (part.synthetic || part.ignored || !part.text) return
      return { kind: "text", text: part.text }
    case "reasoning":
      if (!part.text) return
      return { kind: "reasoning", text: part.text }
    case "file":
      if (!part.filename) return
      return { kind: "file", text: part.filename }
    case "subtask":
      return { kind: "subtask", text: [part.description, part.prompt].filter(Boolean).join("\n") }
    case "tool": {
      const state = part.state ?? {}
      const input = state.input ?? {}
      const chunks = [
        str(state.title),
        ...TOOL_INPUT_KEYS.map((key) => str(input[key])),
        str(state.output),
        str(state.error),
      ].filter(Boolean)
      if (chunks.length === 0) return
      return { kind: "tool", tool: part.tool, text: chunks.join("\n") }
    }
  }
}

export type FindOptions = { caseSensitive?: boolean; regex?: boolean; word?: boolean }

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// 返回 matcher；正则写错时返回 error 字符串
export function createFindMatcher(
  query: string,
  options: FindOptions = {},
): { match: (text: string) => Array<{ start: number; end: number }> } | { error: string } | undefined {
  const raw = options.regex ? query : query.trim()
  if (!raw) return
  let source = options.regex ? raw : escape(raw)
  // \b 对中文不起作用，用“前后不是字母数字下划线”来判断整词
  if (options.word) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`
  let pattern: RegExp
  try {
    pattern = new RegExp(source, `gu${options.caseSensitive ? "" : "i"}`)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  return {
    match(text) {
      const result: Array<{ start: number; end: number }> = []
      pattern.lastIndex = 0
      for (let found = pattern.exec(text); found; found = pattern.exec(text)) {
        if (found[0].length === 0) {
          // 空匹配（如 a*）没有可高亮的内容，往前挪一位避免死循环
          pattern.lastIndex++
          continue
        }
        result.push({ start: found.index, end: found.index + found[0].length })
      }
      return result
    },
  }
}
