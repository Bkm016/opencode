// OpenCode Zen 免费模型：只能从 OpenCode 客户端调用（服务端校验请求头与版本），无需账号，密钥固定为 public。
// Zen 的 /models 接口不带跨域头，浏览器里拉不到列表，这里内置一份实测可用的免费模型。
export const ZEN_PROVIDER_ID = "opencode"

const MODELS: Array<[id: string, name: string]> = [
  ["big-pickle", "Big Pickle"],
  ["nemotron-3-ultra-free", "Nemotron 3 Ultra"],
  ["nemotron-3.5-lightning-free", "Nemotron 3.5 Lightning"],
  ["mimo-v2.6-flash-free", "MiMo V2.6 Flash"],
  ["ling-3.1-flash-free", "Ling 3.1 Flash"],
  ["longcat-2.5-preview-free", "LongCat 2.5 Preview"],
  ["space-bunny-free", "Space Bunny"],
  ["fledge-alpha-free", "Fledge Alpha"],
]

export const ZEN_FREE_MODEL_COUNT = MODELS.length

export function zenFreeProvider() {
  return {
    name: "OpenCode Zen",
    npm: "@ai-sdk/openai-compatible",
    options: { baseURL: "https://opencode.ai/zen/v1", apiKey: "public" },
    models: Object.fromEntries(
      MODELS.map(([id, name]) => [id, { name, tool_call: true, limit: { context: 200000, output: 32000 } }]),
    ),
  }
}
