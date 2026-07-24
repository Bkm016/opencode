const TOOL_NAME_ALIASES = Symbol.for("opencode.toolNameAliases")
const TOOL_INPUT_ALIASES = Symbol.for("opencode.toolInputAliases")

/** Per-tool map of call-site arg keys → canonical parameter names. */
export type InputAliasTable = Readonly<Record<string, Readonly<Record<string, string>>>>

/**
 * Resolve a call-site tool name to a registered id.
 * Order: exact match → unique case-insensitive match → explicit alias table.
 * Alias keys are call-site names; values are registered tool ids.
 */
export function resolveToolName(
  names: Iterable<string>,
  name: string,
  aliases?: Readonly<Record<string, string>>,
): string | undefined {
  const list = Array.from(names)
  if (list.includes(name)) return name

  const lower = name.toLowerCase()
  const caseMatches = list.filter((item) => item.toLowerCase() === lower)
  if (caseMatches.length === 1) return caseMatches[0]

  if (!aliases) return undefined
  const canonical = aliases[name] ?? aliases[lower]
  if (canonical && list.includes(canonical)) return canonical
  return undefined
}

/** Attach non-enumerable name aliases to a tools map (not advertised to the model). */
export function attach(tools: Record<string, unknown>, aliases: Readonly<Record<string, string>>) {
  Object.defineProperty(tools, TOOL_NAME_ALIASES, {
    value: aliases,
    enumerable: false,
    configurable: true,
  })
  return tools
}

export function fromTools(tools: Record<string, unknown>): Readonly<Record<string, string>> | undefined {
  const value = (tools as Record<PropertyKey, unknown>)[TOOL_NAME_ALIASES]
  if (!value || typeof value !== "object") return undefined
  return value as Readonly<Record<string, string>>
}

/** Attach non-enumerable per-tool input aliases (not advertised to the model). */
export function attachInputAliases(tools: Record<string, unknown>, aliases: InputAliasTable) {
  Object.defineProperty(tools, TOOL_INPUT_ALIASES, {
    value: aliases,
    enumerable: false,
    configurable: true,
  })
  return tools
}

export function inputAliasesFromTools(tools: Record<string, unknown>): InputAliasTable | undefined {
  const value = (tools as Record<PropertyKey, unknown>)[TOOL_INPUT_ALIASES]
  if (!value || typeof value !== "object") return undefined
  return value as InputAliasTable
}

export * as ToolNameAlias from "./name-alias"
