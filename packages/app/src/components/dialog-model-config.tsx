import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Switch } from "@opencode-ai/ui/switch"
import { Tag } from "@opencode-ai/ui/tag"
import { TextField } from "@opencode-ai/ui/text-field"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"

const POPULAR_DRIVERS = [
  { label: "OpenAI (@ai-sdk/openai)", value: "@ai-sdk/openai" },
  { label: "OpenAI 兼容协议 (@ai-sdk/openai-compatible)", value: "@ai-sdk/openai-compatible" },
  { label: "Anthropic (@ai-sdk/anthropic)", value: "@ai-sdk/anthropic" },
  { label: "Google (@ai-sdk/google)", value: "@ai-sdk/google" },
] as const

const REASONING_VARIANT_OPTIONS = ["low", "medium", "high", "max", "xhigh"] as const

export interface ProviderFormProps {
  providerID?: string
  initial?: {
    name?: string
    npm?: string
    baseURL?: string
    apiKey?: string
  }
  onBack?: () => void
  onClose?: () => void
}

/**
 * 添加 / 编辑提供商配置对话框
 */
export function DialogProviderConfig(props: ProviderFormProps) {
  const dialog = useDialog()
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const isEditing = !!props.providerID

  const [form, setForm] = createStore({
    id: props.providerID ?? "",
    name: props.initial?.name ?? "",
    npm: props.initial?.npm ?? "@ai-sdk/openai",
    baseURL: props.initial?.baseURL ?? "",
    apiKey: props.initial?.apiKey ?? "",
  })

  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()

  const handleBack = () => {
    if (props.onBack) {
      props.onBack()
      return
    }
    props.onClose?.()
    dialog.close()
  }

  const save = async (e: SubmitEvent) => {
    e.preventDefault()
    if (busy()) return

    const id = form.id.trim()
    if (!id) {
      setError("提供商 ID 不能为空")
      return
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      setError("提供商 ID 仅支持英文字母、数字、下划线和短横线")
      return
    }

    setBusy(true)
    setError(undefined)

    try {
      const currentConfig = serverSync().data.config
      const providers = { ...(currentConfig.provider ?? {}) }
      const existing = providers[id] ?? {}

      const updated = {
        ...existing,
        name: form.name.trim() || id,
        npm: form.npm.trim() || "@ai-sdk/openai",
        options: {
          ...(existing.options ?? {}),
          baseURL: form.baseURL.trim() || undefined,
          apiKey: form.apiKey.trim() || existing.options?.apiKey,
        },
        models: existing.models ?? {},
      }

      providers[id] = updated

      // 若提供了 API Key，同步写入服务凭据
      if (form.apiKey.trim()) {
        await serverSDK()
          .client.auth.set({
            providerID: id,
            auth: { type: "api", key: form.apiKey.trim() },
          })
          .catch(() => undefined)
      }

      await serverSync().updateConfig({ provider: providers })

      showToast({
        variant: "success",
        icon: "circle-check",
        title: isEditing ? "提供商已更新" : "提供商已添加",
        description: `${updated.name} 配置已立即生效。`,
      })

      handleBack()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      showToast({ variant: "error", title: "保存失败", description: msg })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={
        <div class="flex items-center gap-3">
          <IconButton icon="arrow-left" variant="ghost" onClick={handleBack} aria-label={language.t("common.goBack")} />
          <span class="text-16-medium text-text-strong">
            {isEditing ? `编辑提供商: ${form.id}` : "添加新提供商"}
          </span>
        </div>
      }
      size="large"
      class="h-full flex flex-col min-h-0 overflow-hidden"
      transition
    >
      <form onSubmit={save} class="flex flex-col flex-1 min-h-0 overflow-hidden w-full">
        <div class="flex-1 overflow-y-auto px-6 sm:px-8 py-5 flex flex-col gap-6 w-full">
          <Show when={error()}>
            <div class="p-3 text-13-regular rounded-lg bg-surface-critical-base text-text-critical-base">
              {error()}
            </div>
          </Show>

          <div class="flex flex-col gap-5">
            <TextField
              label="提供商 ID (唯一标识)"
              placeholder="例如: asgard-openai, my-deepseek"
              value={form.id}
              disabled={isEditing}
              onChange={(v) => setForm("id", v)}
              description={isEditing ? "提供商 ID 无法更改" : "英文字母、数字与连字符"}
              required
            />

            <TextField
              label="显示名称"
              placeholder="例如: Asgard OpenAI, DeepSeek 官方"
              value={form.name}
              onChange={(v) => setForm("name", v)}
            />

            <div class="flex flex-col gap-2.5">
              <TextField
                label="驱动包 (npm package)"
                placeholder="@ai-sdk/openai"
                value={form.npm}
                onChange={(v) => setForm("npm", v)}
                description="处理此提供商协议的 SDK 驱动包"
              />
              <div class="flex flex-wrap gap-2 pt-1">
                <For each={POPULAR_DRIVERS}>
                  {(driver) => (
                    <button
                      type="button"
                      class="px-2.5 py-1 text-12-regular rounded bg-surface-base hover:bg-surface-weak-base border border-border-weak-base transition-colors"
                      onClick={() => setForm("npm", driver.value)}
                    >
                      {driver.label}
                    </button>
                  )}
                </For>
              </div>
            </div>

            <TextField
              label="API 基础地址 (Base URL)"
              placeholder="例如: https://ai.sacredcraft.cn/v1"
              value={form.baseURL}
              onChange={(v) => setForm("baseURL", v)}
              description="中转或官方 API 接口地址（留空使用驱动默认）"
            />

            <TextField
              label="API 密钥 (API Key)"
              type="password"
              placeholder={isEditing ? "(留空保持原密钥不变)" : "sk-..."}
              value={form.apiKey}
              onChange={(v) => setForm("apiKey", v)}
              description="用于请求此提供商的访问凭证"
            />
          </div>
        </div>

        <div class="shrink-0 w-full px-6 sm:px-8 py-4 border-t border-border-weak-base bg-surface-raised-stronger-non-alpha flex items-center justify-end gap-3">
          <Button variant="ghost" type="button" onClick={handleBack} disabled={busy()}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit" disabled={busy()}>
            {busy() ? "正在保存..." : "保存并立即生效"}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

export interface ModelFormProps {
  providerID: string
  modelID?: string
  initial?: {
    name?: string
    contextLimit?: number
    outputLimit?: number
    reasoning?: boolean
    toolCall?: boolean
    attachment?: boolean
    temperature?: boolean
    variants?: Record<string, any>
  }
  onBack?: () => void
  onClose?: () => void
}

/**
 * 添加 / 编辑模型配置对话框
 */
export function DialogModelConfig(props: ModelFormProps) {
  const dialog = useDialog()
  const language = useLanguage()
  const serverSync = useServerSync()
  const isEditing = !!props.modelID

  const initialReasoning = props.initial?.reasoning ?? true
  const initialVariants = props.initial?.variants
    ? Object.keys(props.initial.variants)
    : ["high", "max"]

  const [form, setForm] = createStore({
    id: props.modelID ?? "",
    name: props.initial?.name ?? "",
    contextLimit: props.initial?.contextLimit ?? 300000,
    outputLimit: props.initial?.outputLimit ?? 64000,
    reasoning: initialReasoning,
    toolCall: props.initial?.toolCall ?? true,
    attachment: props.initial?.attachment ?? true,
    temperature: props.initial?.temperature ?? true,
    variants: initialVariants,
  })

  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()

  const handleBack = () => {
    if (props.onBack) {
      props.onBack()
      return
    }
    props.onClose?.()
    dialog.close()
  }

  const toggleVariant = (variantName: string) => {
    if (form.variants.includes(variantName)) {
      setForm(
        "variants",
        form.variants.filter((v) => v !== variantName),
      )
    } else {
      setForm("variants", [...form.variants, variantName])
    }
  }

  const save = async (e: SubmitEvent) => {
    e.preventDefault()
    if (busy()) return

    const id = form.id.trim()
    if (!id) {
      setError("模型 ID 不能为空")
      return
    }

    setBusy(true)
    setError(undefined)

    try {
      const currentConfig = serverSync().data.config
      const providers = { ...(currentConfig.provider ?? {}) }
      const provider = providers[props.providerID]
      if (!provider) {
        throw new Error(`未找到提供商: ${props.providerID}`)
      }

      const models = { ...(provider.models ?? {}) }
      const existing = models[id] ?? {}

      const nextModel: any = {
        ...existing,
        name: form.name.trim() || id,
        limit: {
          context: Number(form.contextLimit) || 200000,
          output: Number(form.outputLimit) || 64000,
        },
        reasoning: form.reasoning,
        tool_call: form.toolCall,
        attachment: form.attachment,
        temperature: form.temperature,
      }

      if (form.attachment) {
        nextModel.modalities = {
          input: ["text", "image", "pdf"],
          output: ["text"],
        }
      }

      if (form.reasoning && form.variants.length > 0) {
        const variantsMap: Record<string, any> = {}
        for (const v of form.variants) {
          variantsMap[v] = { reasoningEffort: v }
        }
        nextModel.variants = variantsMap
      } else if (!form.reasoning) {
        delete nextModel.variants
      }

      models[id] = nextModel
      providers[props.providerID] = {
        ...provider,
        models,
      }

      await serverSync().updateConfig({ provider: providers })

      showToast({
        variant: "success",
        icon: "circle-check",
        title: isEditing ? "模型已更新" : "模型已添加",
        description: `${nextModel.name} 配置已保存并立即生效。`,
      })

      handleBack()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      showToast({ variant: "error", title: "保存失败", description: msg })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={
        <div class="flex items-center gap-3">
          <IconButton icon="arrow-left" variant="ghost" onClick={handleBack} aria-label={language.t("common.goBack")} />
          <span class="text-16-medium text-text-strong">
            {isEditing ? `编辑模型: ${form.id}` : `添加模型 (${props.providerID})`}
          </span>
        </div>
      }
      size="large"
      class="h-full flex flex-col min-h-0 overflow-hidden"
      transition
    >
      <form onSubmit={save} class="flex flex-col flex-1 min-h-0 overflow-hidden w-full">
        <div class="flex-1 overflow-y-auto px-6 sm:px-8 py-5 flex flex-col gap-6 w-full">
          <Show when={error()}>
            <div class="p-3 text-13-regular rounded-lg bg-surface-critical-base text-text-critical-base">
              {error()}
            </div>
          </Show>

          <div class="flex flex-col gap-5">
            <TextField
              label="模型 ID"
              placeholder="例如: kimi-k3, gpt-5.6-sol, gemini-3.8-flash"
              value={form.id}
              disabled={isEditing}
              onChange={(v) => setForm("id", v)}
              description={isEditing ? "模型 ID 无法修改" : "提供商接口接收的真实模型名称/版本"}
              required
            />

            <TextField
              label="显示名称"
              placeholder="例如: Kimi K3, GPT-5.6 Sol"
              value={form.name}
              onChange={(v) => setForm("name", v)}
              description="在对话窗口选择器中展示的易读名称"
            />

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
              <TextField
                label="上下文上限 (Context Limit)"
                type="number"
                placeholder="300000"
                value={String(form.contextLimit)}
                onChange={(v) => setForm("contextLimit", Number(v) || 0)}
                description="模型支持的最大输入 Token 数量"
              />
              <TextField
                label="输出上限 (Output Limit)"
                type="number"
                placeholder="64000"
                value={String(form.outputLimit)}
                onChange={(v) => setForm("outputLimit", Number(v) || 0)}
                description="模型单次生成的最大 Token 数量"
              />
            </div>

            <div class="flex flex-col gap-3 pt-2">
              <span class="text-13-medium text-text-strong">模型能力配置</span>

              <div class="flex items-center justify-between py-2.5 border-b border-border-weak-base">
                <div class="flex flex-col">
                  <span class="text-14-medium text-text-strong">思考 / 推理 (Reasoning)</span>
                  <span class="text-12-regular text-text-weak">支持深度思考链和 reasoningEffort 档位</span>
                </div>
                <Switch checked={form.reasoning} onChange={(checked) => setForm("reasoning", checked)} hideLabel>
                  思考 / 推理
                </Switch>
              </div>

              <Show when={form.reasoning}>
                <div class="flex flex-col gap-2.5 p-3.5 bg-surface-base rounded-lg border border-border-weak-base">
                  <span class="text-12-medium text-text-weak">支持的思考强度变体 (Variants)</span>
                  <div class="flex flex-wrap gap-2">
                    <For each={REASONING_VARIANT_OPTIONS}>
                      {(v) => {
                        const active = () => form.variants.includes(v)
                        return (
                          <button
                            type="button"
                            class="px-3 py-1.5 text-12-medium rounded-md border transition-colors"
                            classList={{
                              "bg-primary-base text-text-inverse-base border-transparent": active(),
                              "bg-surface-weak-base text-text-strong border-border-weak-base hover:bg-surface-base":
                                !active(),
                            }}
                            onClick={() => toggleVariant(v)}
                          >
                            {v}
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
                <Switch checked={form.toolCall} onChange={(checked) => setForm("toolCall", checked)} hideLabel>
                  工具调用
                </Switch>
              </div>

              <div class="flex items-center justify-between py-2.5 border-b border-border-weak-base">
                <div class="flex flex-col">
                  <span class="text-14-medium text-text-strong">视觉与附件 (Vision / Attachment)</span>
                  <span class="text-12-regular text-text-weak">支持图片、PDF 等多模态附件输入</span>
                </div>
                <Switch checked={form.attachment} onChange={(checked) => setForm("attachment", checked)} hideLabel>
                  视觉与附件
                </Switch>
              </div>

              <div class="flex items-center justify-between py-2.5">
                <div class="flex flex-col">
                  <span class="text-14-medium text-text-strong">温度调节 (Temperature)</span>
                  <span class="text-12-regular text-text-weak">允许动态控制模型生成随机度</span>
                </div>
                <Switch checked={form.temperature} onChange={(checked) => setForm("temperature", checked)} hideLabel>
                  温度调节
                </Switch>
              </div>
            </div>
          </div>
        </div>

        <div class="shrink-0 w-full px-6 sm:px-8 py-4 border-t border-border-weak-base bg-surface-raised-stronger-non-alpha flex items-center justify-end gap-3">
          <Button variant="ghost" type="button" onClick={handleBack} disabled={busy()}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit" disabled={busy()}>
            {busy() ? "正在保存..." : "保存并立即生效"}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

/**
 * 通用确认操作对话框
 */
export function DialogConfirmAction(props: {
  title: string
  description: string
  confirmText?: string
  danger?: boolean
  onConfirm: () => Promise<void> | void
  onClose?: () => void
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [busy, setBusy] = createSignal(false)

  const close = () => {
    props.onClose?.()
    dialog.close()
  }

  const run = async () => {
    if (busy()) return
    setBusy(true)
    try {
      await props.onConfirm()
      close()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog title={props.title} size="normal" transition>
      <div class="flex flex-col gap-4 px-4 pb-6 pt-2">
        <p class="text-14-regular text-text-base leading-relaxed">{props.description}</p>
        <div class="flex items-center justify-end gap-3 pt-2">
          <Button variant="ghost" onClick={close} disabled={busy()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            class={props.danger ? "bg-surface-critical-base text-text-critical-base hover:bg-surface-critical-base/80" : undefined}
            onClick={run}
            disabled={busy()}
          >
            {busy() ? "处理中..." : (props.confirmText ?? language.t("common.confirm"))}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
