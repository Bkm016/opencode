import type { Component, JSX } from "solid-js"
import { createMemo, splitProps } from "solid-js"
import sprite from "./provider-icons/sprite.svg"
import { iconNames, type IconName } from "./provider-icons/types"

export type ProviderIconProps = JSX.SVGElementTags["svg"] & {
  id: string
  /** Model id such as "gemini-3.8-flash"; takes priority over the provider id */
  model?: string
  /** Model family reported by the provider catalog, e.g. "gemini-flash" */
  family?: string
}

const candidates = iconNames.filter((name) => name !== "synthetic" && name !== "llama")

// Provider ids with no direct sprite entry
const providerAliases: Record<string, IconName> = {
  ollama: "ollama-cloud",
  "lm-studio": "lmstudio",
  aws: "amazon-bedrock",
  bedrock: "amazon-bedrock",
  hf: "huggingface",
  "hugging-face": "huggingface",
}

// Model family/name tokens mapped to the vendor brand sprite
const modelAliases: [pattern: RegExp, icon: IconName][] = [
  [/^claude|^anthropic/, "anthropic"],
  [/gpt|^o\d|codex|dall-e|sora|whisper|chatgpt|openai/, "openai"],
  [/gemini|gemma|^veo|imagen|lyria|nano-banana|google/, "google"],
  [/grok|^xai/, "xai"],
  [/glm|zhipu|chatglm/, "zhipuai"],
  [/qwen|dashscope|tongyi|^wan\d|alibaba|^ling/, "alibaba"],
  [/kimi|moonshot/, "moonshotai"],
  [/mimo|xiaomi/, "xiaomi"],
  [/minimax/, "minimax"],
  [/deepseek/, "deepseek"],
  [/mistral|mixtral|codestral|devstral|magistral|ministral|pixtral|voxtral/, "mistral"],
  [/nemotron|nvidia/, "nvidia"],
  [/step|stepfun/, "stepfun"],
  [/nova|amazon|bedrock/, "amazon-bedrock"],
  [/command|cohere/, "cohere"],
  [/sonar|perplexity/, "perplexity"],
  [/kilo/, "kilo"],
  [/swe|devin|cognition/, "cognition"],
  [/llama|meta|muse/, "meta"],
  [/ernie|baidu/, "alibaba"],
  [/hunyuan|tencent/, "tencent-coding-plan"],
  [/seed|doubao|bytedance/, "alibaba"],
  [/morph/, "morph"],
  [/mercury|inception/, "inception"],
  [/marin|openrouter/, "openrouter"],
]

// A contained match only counts at a boundary (start of string or after a
// separator), so "ollama" cannot resolve to "llama". Icon names starting
// with a digit ("302ai") may also follow a letter.
function contained(id: string, icon: string) {
  const i = id.indexOf(icon)
  if (i === 0) return true
  if (i < 0) return false
  const prev = id[i - 1]
  return !/[a-z0-9]/.test(prev) || /\d/.test(icon[0])
}

function resolveName(id: string, aliases: Record<string, IconName>): IconName | undefined {
  const name = id.toLowerCase().trim()
  if (!name) return
  if (iconNames.includes(name as IconName)) return name as IconName
  const alias = aliases[name]
  if (alias) return alias
  const forward = candidates.filter((icon) => contained(name, icon))
  if (forward.length > 0) return forward.reduce((a, b) => (b.length > a.length ? b : a))
  const flat = name.replace(/[^a-z0-9]/g, "")
  const collapsed = candidates.find((icon) => icon.replace(/[^a-z0-9]/g, "") === flat)
  if (collapsed) return collapsed
  // Short ids like "moonshot" or "bedrock" expand to variant icon names such
  // as "moonshotai" or "amazon-bedrock"; require length to limit false hits
  if (name.length >= 4) {
    const reverse = candidates.filter((icon) => icon.startsWith(name) || icon.includes(`-${name}`))
    if (reverse.length > 0) return reverse.reduce((a, b) => (b.length < a.length ? b : a))
  }
  const token = name.split(/[^a-z0-9]+/).find((part) => aliases[part])
  if (token) return aliases[token]
}

function resolveModel(value: string | undefined): IconName | undefined {
  const name = (value ?? "").toLowerCase().trim()
  if (!name) return
  const direct = resolveName(name, {})
  if (direct && direct !== "synthetic") return direct
  for (const [pattern, icon] of modelAliases) {
    if (pattern.test(name)) return icon
  }
}

export const ProviderIcon: Component<ProviderIconProps> = (props) => {
  const [local, rest] = splitProps(props, ["id", "model", "family", "class", "classList"])
  const resolved = createMemo(
    () =>
      resolveModel(local.family) ?? resolveModel(local.model) ?? resolveName(local.id, providerAliases) ?? "synthetic",
  )
  return (
    <svg
      data-component="provider-icon"
      {...rest}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <use href={`${sprite}#${resolved()}`} />
    </svg>
  )
}
