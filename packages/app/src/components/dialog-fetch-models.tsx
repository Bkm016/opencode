import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { Switch } from "@opencode-ai/ui/switch"
import { TextField } from "@opencode-ai/ui/text-field"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createSignal, For, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"

const REASONING_VARIANT_OPTIONS = ["low", "medium", "high", "max", "xhigh"] as const

type RemoteModel = {
  id: string
  contextLimit?: number
  outputLimit?: number
}

type ModelForm = {
  name: string
  contextLimit: number
  outputLimit: number
  reasoning: boolean
  toolCall: boolean
  attachment: boolean
  temperature: boolean
  variants: string[]
}

function readNumber(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value
    if (typeof value === "string" && Number(value) > 0) return Number(value)
  }
  return undefined
}

// 兼容 OpenAI 风格 { data: [...] }、{ models: [...] } 和裸数组三种返回。
function parseModels(payload: unknown): RemoteModel[] {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { data?: unknown })?.data)
      ? ((payload as { data: unknown[] }).data as unknown[])
      : Array.isArray((payload as { models?: unknown })?.models)
        ? ((payload as { models: unknown[] }).models as unknown[])
        : []

  return rows.flatMap((row) => {
    if (typeof row === "string") return row.trim() ? [{ id: row.trim() }] : []
    if (!row || typeof row !== "object") return []
    const record = row as Record<string, unknown>
    const id =
      typeof record.id === "string" ? record.id : typeof record.name === "string" ? record.name : undefined
    if (!id?.trim()) return []
    return [
      {
        id: id.trim(),
        contextLimit: readNumber(record, [
          "context_length",
          "context_window",
          "max_context_length",
          "max_input_tokens",
          "inputTokenLimit",
        ]),
        outputLimit: readNumber(record, ["max_tokens", "max_output_tokens", "maxOutputTokens", "outputTokenLimit"]),
      },
    ]
  })
}

function defaultForm(model: RemoteModel): ModelForm {
  return {
    name: model.id,
    contextLimit: model.contextLimit ?? 300000,
    outputLimit: model.outputLimit ?? 64000,
    reasoning: true,
    toolCall: true,
    attachment: true,
    temperature: true,
    variants: ["high", "max"],
  }
}

export function DialogFetchModels(props: {
  providerID: string
  providerName: string
  baseURL?: string
  apiKey?: string
  existingIDs: string[]
}) {
  const dialog = useDialog()
  const serverSync = useServerSync()

  const [status, setStatus] = createSignal<"loading" | "error" | "ready">("loading")
  const [error, setError] = createSignal<string>()
  const [models, setModels] = createSignal<RemoteModel[]>([])
  const [selected, setSelected] = createStore<Record<string, boolean>>({})
  const [expanded, setExpanded] = createStore<Record<string, boolean>>({})
  const [forms, setForms] = createStore<Record<string, ModelForm>>({})
  const [busy, setBusy] = createSignal(false)

  const endpoint = () => `${(props.baseURL ?? "").replace(/\/+$/, "")}/models`
  const selectedCount = () => models().filter((model) => selected[model.id]).length
  const form = (id: string) => forms[id] ?? defaultForm({ id })

  const load = async () => {
    setStatus("loading")
    setError(undefined)
    try {
      const response = await fetch(endpoint(), {
        headers: props.apiKey
          ? { accept: "application/json", authorization: `Bearer ${props.apiKey}` }
          : { accept: "application/json" },
      })
      if (!response.ok) {
        throw new Error(
          response.status === 401 || response.status === 403
            ? `HTTP ${response.status}：API Key 无效或缺失，请先在「编辑提供商」中填写密钥`
            : `HTTP ${response.status} ${response.statusText}`,
        )
      }
      const list = parseModels(await response.json()).filter((model) => !props.existingIDs.includes(model.id))
      setModels(list)
      for (const model of list) {
        if (forms[model.id]) continue
        setForms(model.id, defaultForm(model))
        setSelected(model.id, true)
      }
      setStatus("ready")
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(
        msg.includes("Failed to fetch") || msg.includes("NetworkError")
          ? "无法访问该地址（可能是跨域限制或网络不通），可改用「添加模型」手动配置。"
          : msg,
      )
      setStatus("error")
    }
  }

  onMount(load)

  const toggleAll = () => {
    const target = selectedCount() !== models().length
    for (const model of models()) setSelected(model.id, target)
  }

  const toggleVariant = (id: string, variant: string) => {
    const current = form(id).variants
    setForms(
      id,
      "variants",
      current.includes(variant) ? current.filter((value) => value !== variant) : [...current, variant],
    )
  }

  const save = async () => {
    if (busy()) return
    const picked = models().filter((model) => selected[model.id])
    if (picked.length === 0) return

    setBusy(true)
    try {
      const currentConfig = serverSync().data.config
      const providers = { ...(currentConfig.provider ?? {}) }
      const provider = providers[props.providerID] as Record<string, any> | undefined
      if (!provider) throw new Error(`未找到提供商: ${props.providerID}`)

      const models = { ...(provider.models ?? {}) }
      for (const model of picked) {
        const f = form(model.id)
        const next: Record<string, any> = {
          name: f.name.trim() || model.id,
          limit: { context: Number(f.contextLimit) || 200000, output: Number(f.outputLimit) || 64000 },
          reasoning: f.reasoning,
          tool_call: f.toolCall,
          attachment: f.attachment,
          temperature: f.temperature,
        }
        if (f.attachment) next.modalities = { input: ["text", "image", "pdf"], output: ["text"] }
        if (f.reasoning && f.variants.length > 0) {
          next.variants = Object.fromEntries(f.variants.map((value) => [value, { reasoningEffort: value }]))
        }
        models[model.id] = next
      }

      providers[props.providerID] = { ...provider, models }
      await serverSync().updateConfig({ provider: providers })

      showToast({
        variant: "success",
        icon: "circle-check",
        title: "模型已添加",
        description: `已为 ${props.providerName} 添加 ${picked.length} 个模型。`,
      })
      dialog.close()
    } catch (err) {
      showToast({
        variant: "error",
        title: "保存失败",
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={
        <div class="flex flex-col gap-0.5">
          <span class="text-16-medium text-text-strong">获取可用模型: {props.providerName}</span>
          <span class="text-11-regular text-text-weak font-mono truncate">{endpoint()}</span>
        </div>
      }
      size="large"
      class="h-full flex flex-col min-h-0 overflow-hidden"
      transition
    >
      <div class="flex flex-col flex-1 min-h-0 overflow-hidden w-full">
        <div class="shrink-0 flex items-center justify-between gap-3 px-6 sm:px-8 py-3 border-b border-border-weak-base">
          <Show when={status() === "ready"}>
            <span class="text-12-regular text-text-weak">
              发现 {models().length} 个可添加模型，已选 {selectedCount()} 个
            </span>
          </Show>
          <Show when={status() !== "ready"}>
            <span class="text-12-regular text-text-weak">
              {status() === "loading" ? "正在拉取模型列表..." : "拉取失败"}
            </span>
          </Show>
          <div class="flex items-center gap-1">
            <Show when={status() === "ready" && models().length > 0}>
              <Button size="small" variant="ghost" class="text-12-regular" onClick={toggleAll}>
                {selectedCount() === models().length ? "清空选择" : "全选"}
              </Button>
            </Show>
            <Button size="small" variant="ghost" icon="reset" class="text-12-regular" onClick={load} disabled={status() === "loading"}>
              重新拉取
            </Button>
          </div>
        </div>

        <div class="flex-1 overflow-y-auto no-scrollbar px-6 sm:px-8 py-4 flex flex-col gap-2">
          <Show when={status() === "error"}>
            <div class="p-3 text-13-regular rounded-lg bg-surface-critical-base text-text-critical-base">
              {error()}
            </div>
          </Show>

          <Show when={status() === "ready" && models().length === 0}>
            <div class="py-10 text-center text-13-regular text-text-weak bg-surface-base rounded-lg">
              该接口返回的模型都已配置过了。
            </div>
          </Show>

          <For each={models()}>
            {(model) => (
              <div class="shrink-0 rounded-lg border border-border-weak-base overflow-hidden bg-surface-base/40">
                <div class="flex items-center gap-3 px-3 py-2">
                  <Checkbox
                    checked={!!selected[model.id]}
                    onChange={(checked) => setSelected(model.id, !!checked)}
                    hideLabel
                  >
                    {model.id}
                  </Checkbox>
                  <button
                    type="button"
                    class="flex flex-1 items-center gap-2 min-w-0 text-left"
                    onClick={() => setExpanded(model.id, !expanded[model.id])}
                  >
                    <span class="text-13-medium text-text-strong truncate">
                      {form(model.id).name || model.id}
                    </span>
                    <Show when={(form(model.id).name || model.id) !== model.id}>
                      <span class="text-11-regular text-text-weak font-mono truncate">{model.id}</span>
                    </Show>
                    <Icon
                      name="chevron-down"
                      size="small"
                      class="shrink-0 text-icon-weak-base transition-transform"
                      classList={{ "rotate-180": expanded[model.id] }}
                    />
                  </button>
                </div>

                <Show when={expanded[model.id]}>
                  <div class="px-3 pb-4 pt-1 flex flex-col gap-5 border-t border-border-weak-base/40">
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <TextField
                        label="显示名称"
                        value={form(model.id).name}
                        onChange={(value) => setForms(model.id, "name", value)}
                        description="在模型选择器中展示的名称"
                      />
                      <div />
                      <TextField
                        label="上下文上限 (Context Limit)"
                        type="number"
                        value={String(form(model.id).contextLimit)}
                        onChange={(value) => setForms(model.id, "contextLimit", Number(value) || 0)}
                        description="模型支持的最大输入 Token 数量"
                      />
                      <TextField
                        label="输出上限 (Output Limit)"
                        type="number"
                        value={String(form(model.id).outputLimit)}
                        onChange={(value) => setForms(model.id, "outputLimit", Number(value) || 0)}
                        description="模型单次生成的最大 Token 数量"
                      />
                    </div>

                    <div class="flex flex-col gap-3">
                      <span class="text-13-medium text-text-strong">模型能力配置</span>

                      <div class="flex items-center justify-between py-2.5 border-b border-border-weak-base">
                        <div class="flex flex-col">
                          <span class="text-14-medium text-text-strong">思考 / 推理 (Reasoning)</span>
                          <span class="text-12-regular text-text-weak">支持深度思考链和 reasoningEffort 档位</span>
                        </div>
                        <Switch
                          checked={form(model.id).reasoning}
                          onChange={(checked) => setForms(model.id, "reasoning", checked)}
                          hideLabel
                        >
                          思考 / 推理
                        </Switch>
                      </div>

                      <Show when={form(model.id).reasoning}>
                        <div class="flex flex-col gap-2.5 p-3.5 bg-surface-base rounded-lg border border-border-weak-base">
                          <span class="text-12-medium text-text-weak">支持的思考强度变体 (Variants)</span>
                          <div class="flex flex-wrap gap-2">
                            <For each={REASONING_VARIANT_OPTIONS}>
                              {(variant) => {
                                const active = () => form(model.id).variants.includes(variant)
                                return (
                                  <button
                                    type="button"
                                    class="px-3 py-1.5 text-12-medium rounded-md border transition-colors"
                                    classList={{
                                      "bg-primary-base text-text-inverse-base border-transparent": active(),
                                      "bg-surface-weak-base text-text-strong border-border-weak-base hover:bg-surface-base":
                                        !active(),
                                    }}
                                    onClick={() => toggleVariant(model.id, variant)}
                                  >
                                    {variant}
                                  </button>
                                )
                              }}
                            </For>
                          </div>
                        </div>
                      </Show>

                      <div class="flex items-center justify-between py-2.5 border-b border-border-weak-base">
                        <div class="flex flex-col">
                          <span class="text-14-medium text-text-strong">工具调用 (Tool Call)</span>
                          <span class="text-12-regular text-text-weak">支持运行命令、读写文件等 Agent 工具</span>
                        </div>
                        <Switch
                          checked={form(model.id).toolCall}
                          onChange={(checked) => setForms(model.id, "toolCall", checked)}
                          hideLabel
                        >
                          工具调用
                        </Switch>
                      </div>

                      <div class="flex items-center justify-between py-2.5 border-b border-border-weak-base">
                        <div class="flex flex-col">
                          <span class="text-14-medium text-text-strong">视觉与附件 (Vision / Attachment)</span>
                          <span class="text-12-regular text-text-weak">支持图片、PDF 等多模态附件输入</span>
                        </div>
                        <Switch
                          checked={form(model.id).attachment}
                          onChange={(checked) => setForms(model.id, "attachment", checked)}
                          hideLabel
                        >
                          视觉与附件
                        </Switch>
                      </div>

                      <div class="flex items-center justify-between py-2.5">
                        <div class="flex flex-col">
                          <span class="text-14-medium text-text-strong">温度调节 (Temperature)</span>
                          <span class="text-12-regular text-text-weak">允许动态控制模型生成随机度</span>
                        </div>
                        <Switch
                          checked={form(model.id).temperature}
                          onChange={(checked) => setForms(model.id, "temperature", checked)}
                          hideLabel
                        >
                          温度调节
                        </Switch>
                      </div>
                    </div>
                  </div>
                </Show>
              </div>
            )}
          </For>
        </div>

        <div class="shrink-0 w-full px-6 sm:px-8 py-4 border-t border-border-weak-base bg-surface-raised-stronger-non-alpha flex items-center justify-end gap-3">
          <Button variant="ghost" type="button" onClick={() => dialog.close()} disabled={busy()}>
            取消
          </Button>
          <Button variant="primary" type="button" onClick={save} disabled={busy() || selectedCount() === 0}>
            {busy() ? "正在保存..." : `添加选中的 ${selectedCount()} 个模型`}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
