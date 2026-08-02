export * as RunScript from "./run-script"

import { Effect, Schema } from "effect"
import path from "path"

export class ParseError extends Schema.TaggedErrorClass<ParseError>()("RunScriptParseError", {
  path: Schema.String,
  detail: Schema.String,
}) {
  override get message() {
    return `Failed to load run scripts from ${this.path}: ${this.detail}`
  }
}

/** Resolve the authoritative `.opencode/run.json` path for a project directory. */
export function filePath(directory: string) {
  return path.join(directory, ".opencode", "run.json")
}

/**
 * Parse the raw JSON value of a run script file into a name -> command map.
 *
 * Supports both the canonical `{ "scripts": { ... } }` form and a bare
 * top-level `{ name: command }` map. Throws a descriptive ParseError on any
 * structural problem instead of silently yielding an empty list, so callers
 * can decide whether to surface it (editor UI) or tolerate it (best-effort
 * command list).
 */
export function parse(filepath: string, value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ParseError({ path: filepath, detail: "expected a JSON object" })
  }
  const record = value as Record<string, unknown>
  const scripts = "scripts" in record ? record.scripts : record
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) {
    throw new ParseError({ path: filepath, detail: '"scripts" must be an object mapping names to commands' })
  }
  const result: Record<string, string> = {}
  for (const [name, template] of Object.entries(scripts)) {
    // $schema is a JSON-schema hint, not a script entry.
    if (name === "$schema") continue
    if (typeof template !== "string") {
      throw new ParseError({ path: filepath, detail: `script "${name}" must be a string command` })
    }
    result[name] = template
  }
  return result
}

/** Effectful variant of `parse` that fails with a typed ParseError on malformed input. */
export const parseEffect = (filepath: string, value: unknown): Effect.Effect<Record<string, string>, ParseError> =>
  Effect.try({
    try: () => parse(filepath, value),
    catch: (error) => error as ParseError,
  })
