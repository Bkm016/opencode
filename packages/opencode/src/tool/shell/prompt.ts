import { Schema } from "effect"
import DESCRIPTION from "./shell.txt"
import { PositiveInt } from "@opencode-ai/core/schema"

export type Limits = {
  maxLines: number
  maxBytes: number
}

export function parameterSchema() {
  return Schema.Struct({
    command: Schema.String.annotate({ description: "The command to execute" }),
    timeout: Schema.optional(PositiveInt).annotate({ description: "Optional timeout in milliseconds" }),
    workdir: Schema.optional(Schema.String).annotate({
      description: "Working directory, local or remote. Defaults to the current directory.",
    }),
    host: Schema.optional(Schema.String).annotate({
      description: "SSH config alias or user@ip. Omit for local execution; remote commands use bash and require key authentication.",
    }),
  })
}

export const Parameters = parameterSchema()
export type Parameters = Schema.Schema.Type<typeof Parameters>

function renderPrompt(template: string, values: Record<string, string>) {
  return template.replace(/\$\{(\w+)\}/g, (_, key: string) => {
    const value = values[key]
    if (value === undefined) throw new Error(`Missing shell prompt value: ${key}`)
    return value
  })
}

function shellNotes(name: string) {
  if (name === "powershell" || name === "pwsh") {
    const chain =
      name === "powershell"
        ? "PowerShell 5.1 has no &&; chain dependent commands with `cmd1; if ($?) { cmd2 }`."
        : "PowerShell 7+ supports && and ||; use && for dependent commands."
    return `- ${chain} Use ; only when later commands need not depend on success.
- Double quotes interpolate; single quotes are literal; backtick escapes. Prefer full cmdlet names. Use \`$(...)\` for subexpressions and \`@(...)\` for arrays.
- Invoke quoted executables with \`& "path/to/exe" args\`. Check parent paths with \`Test-Path -LiteralPath\`.`
  }
  if (name === "cmd") {
    return `- Chain dependent commands with &&; use & only when later commands need not depend on success.
- Use double-quoted paths, %VAR% environment variables, \`if exist\` to check parent paths, and \`call\` for batch files.`
  }
  return "- Chain dependent commands with &&; use ; only when later commands need not depend on success. Verify parent paths with ls."
}

export function render(name: string, platform: NodeJS.Platform, limits: Limits, defaultTimeoutMs: number, tmp: string) {
  return {
    description: renderPrompt(DESCRIPTION, {
      os: platform,
      shell: name,
      tmp,
      shellNotes: shellNotes(name),
      defaultTimeoutMs: String(defaultTimeoutMs),
      maxLines: String(limits.maxLines),
      maxBytes: String(limits.maxBytes),
    }),
    parameters: parameterSchema(),
  }
}

export * as ShellPrompt from "./prompt"
