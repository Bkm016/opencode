import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Switch } from "@opencode-ai/ui/switch"
import { Tag } from "@opencode-ai/ui/tag"
import { TextField } from "@opencode-ai/ui/text-field"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { type Component, createMemo, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { DialogConfirmAction, DialogModelConfig, DialogProviderConfig } from "./dialog-model-config"
import { DialogSettings } from "./dialog-settings"
import { SettingsList } from "./settings-list"
import { SettingsServerPicker, SettingsServerScope } from "./settings-server-picker"

function formatTokenLimit(num: number | undefined): string {
  if (!num) return "—"
  if (num >= 1000000) return `${(num / 1000000).toFixed(num % 1000000 === 0 ? 0 : 1)}M`
  if (num >= 1000) return `${(num / 1000).toFixed(num % 1000 === 0 ? 0 : 1)}k`
  return String(num)
}

export const SettingsModels: Component = () => {
  return (
    <SettingsServerScope>
      <SettingsModelsContent />
    </SettingsServerScope>
  )
}

const SettingsModelsContent: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const models = useModels()
  const platform = usePlatform()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()

  const [search, setSearch] = createSignal("")

  // 从本地配置获取 provider 字典
  const configuredProviders = createMemo(() => {
    return serverSync().data.config.provider ?? {}
  })

  // 过滤后的本地提供商列表
  const providerEntries = createMemo(() => {
    const raw = Object.entries(configuredProviders())
    const q = search().trim().toLowerCase()
    if (!q) return raw

    return raw.filter(([providerID, provider]) => {
      const matchProvider =
        providerID.toLowerCase().includes(q) ||
        (provider.name && provider.name.toLowerCase().includes(q)) ||
        (provider.npm && provider.npm.toLowerCase().includes(q))
      if (matchProvider) return true

      const modelList = Object.entries(provider.models ?? {})
      return modelList.some(
        ([modelID, m]) =>
          modelID.toLowerCase().includes(q) || (m.name && m.name.toLowerCase().includes(q)),
      )
    })
  })

  // 打开本地配置目录/文件
  const canOpenConfig = createMemo(() => platform.platform === "desktop" && !!platform.openPath)

  const openConfigFolder = async () => {
    if (!platform.openPath) return
    try {
      const res = await serverSDK().client.path.get()
      const configDir = res.data?.config
      if (configDir) {
        await platform.openPath(configDir)
        showToast({
          variant: "success",
          icon: "circle-check",
          title: "已在外部打开配置目录",
          description: configDir,
        })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      showToast({ variant: "error", title: "无法打开配置目录", description: msg })
    }
  }

  // 返回到设置-模型页
  const backToSettings = () => {
    dialog.show(() => <DialogSettings defaultValue="models" />)
  }

  // 添加提供商
  const addProvider = () => {
    dialog.show(() => <DialogProviderConfig onBack={backToSettings} />)
  }

  // 编辑提供商
  const editProvider = (providerID: string, p: any) => {
    dialog.show(() => (
      <DialogProviderConfig
        providerID={providerID}
        initial={{
          name: p.name,
          npm: p.npm,
          baseURL: p.options?.baseURL,
          apiKey: p.options?.apiKey,
        }}
        onBack={backToSettings}
      />
    ))
  }

  // 删除提供商
  const deleteProvider = (providerID: string, name: string) => {
    dialog.show(() => (
      <DialogConfirmAction
        title="删除提供商"
        description={`确定要删除提供商「${name || providerID}」(${providerID}) 吗？其下所有配置的模型也将一并移除，此操作会立即写回本地配置。`}
        danger
        confirmText="确认删除"
        onClose={backToSettings}
        onConfirm={async () => {
          const current = serverSync().data.config
          const providers = { ...(current.provider ?? {}) }
          delete providers[providerID]
          await serverSync().updateConfig({ provider: providers })
          showToast({
            variant: "success",
            icon: "circle-check",
            title: "提供商已删除",
            description: `${name || providerID} 已移除并生效。`,
          })
          backToSettings()
        }}
      />
    ))
  }

  // 添加模型
  const addModel = (providerID: string) => {
    dialog.show(() => <DialogModelConfig providerID={providerID} onBack={backToSettings} />)
  }

  // 编辑模型
  const editModel = (providerID: string, modelID: string, m: any) => {
    dialog.show(() => (
      <DialogModelConfig
        providerID={providerID}
        modelID={modelID}
        initial={{
          name: m.name,
          contextLimit: m.limit?.context,
          outputLimit: m.limit?.output,
          reasoning: m.reasoning,
          toolCall: m.tool_call,
          attachment: m.attachment,
          temperature: m.temperature,
          variants: m.variants,
        }}
        onBack={backToSettings}
      />
    ))
  }

  // 克隆模型
  const cloneModel = (providerID: string, modelID: string, m: any) => {
    dialog.show(() => (
      <DialogModelConfig
        providerID={providerID}
        modelID={`${modelID}-copy`}
        initial={{
          name: m.name ? `${m.name} (Copy)` : undefined,
          contextLimit: m.limit?.context,
          outputLimit: m.limit?.output,
          reasoning: m.reasoning,
          toolCall: m.tool_call,
          attachment: m.attachment,
          temperature: m.temperature,
          variants: m.variants,
        }}
        onBack={backToSettings}
      />
    ))
  }

  // 删除模型
  const deleteModel = (providerID: string, modelID: string, modelName: string) => {
    dialog.show(() => (
      <DialogConfirmAction
        title="删除模型"
        description={`确定要删除模型「${modelName || modelID}」吗？此操作会立即从本地配置中删除并生效。`}
        danger
        confirmText="确认删除"
        onClose={backToSettings}
        onConfirm={async () => {
          const current = serverSync().data.config
          const providers = { ...(current.provider ?? {}) }
          const target = providers[providerID]
          if (target && target.models) {
            const nextModels = { ...target.models }
            delete nextModels[modelID]
            providers[providerID] = { ...target, models: nextModels }
            await serverSync().updateConfig({ provider: providers })
            showToast({
              variant: "success",
              icon: "circle-check",
              title: "模型已删除",
              description: `${modelName || modelID} 已从配置移除并生效。`,
            })
            backToSettings()
          }
        }}
      />
    ))
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      {/* 顶部 Sticky 工具栏 */}
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-4 pt-6 pb-6 max-w-[800px]">
          <div class="flex items-center justify-between gap-4">
            <div class="flex items-center gap-2">
              <h2 class="text-16-medium text-text-strong">{language.t("settings.models.title")}</h2>
              <Tag size="normal">本地配置直连</Tag>
            </div>
            <div class="flex items-center gap-2">
              <Show when={canOpenConfig()}>
                <Button
                  size="normal"
                  variant="secondary"
                  icon="folder"
                  onClick={openConfigFolder}
                  title="在系统文件管理器中打开配置目录"
                >
                  配置目录
                </Button>
              </Show>
              <Button size="normal" variant="primary" icon="plus-small" onClick={addProvider}>
                添加提供商
              </Button>
              <SettingsServerPicker />
            </div>
          </div>

          <div class="flex items-center gap-2 px-3 h-9 rounded-lg bg-surface-base">
            <Icon name="magnifying-glass" class="text-icon-weak-base flex-shrink-0" />
            <TextField
              variant="ghost"
              type="text"
              value={search()}
              onChange={setSearch}
              placeholder="搜索模型名称、ID 或提供商..."
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              class="flex-1"
            />
            <Show when={search()}>
              <IconButton icon="circle-x" variant="ghost" onClick={() => setSearch("")} />
            </Show>
          </div>
        </div>
      </div>

      {/* 主内容区域 */}
      <div class="flex flex-col gap-8 max-w-[800px]">
        {/* 本地配置的 Providers */}
        <Show
          when={providerEntries().length > 0}
          fallback={
            <div class="flex flex-col items-center justify-center py-12 px-4 rounded-xl border border-dashed border-border-weak-base text-center bg-surface-base/50">
              <Icon name="models" class="size-8 text-icon-weak-base mb-3" />
              <span class="text-15-medium text-text-strong">
                {search() ? "未找到匹配的模型或提供商" : "本地尚未配置任何 AI 提供商"}
              </span>
              <p class="text-13-regular text-text-weak mt-1 mb-5 max-w-md">
                无需再手动编辑死板的 JSON 文件，直接通过表单添加你的提供商与模型，修改即刻保存并热重载生效。
              </p>
              <Show when={!search()}>
                <Button variant="primary" icon="plus" onClick={addProvider}>
                  添加第一个提供商
                </Button>
              </Show>
            </div>
          }
        >
          <For each={providerEntries()}>
            {([providerID, provider]) => {
              const allModels = createMemo(() => Object.entries(provider.models ?? {}))
              const q = search().trim().toLowerCase()
              const filteredModels = createMemo(() => {
                if (!q) return allModels()
                return allModels().filter(
                  ([id, m]) =>
                    id.toLowerCase().includes(q) ||
                    (m.name && m.name.toLowerCase().includes(q)) ||
                    providerID.toLowerCase().includes(q) ||
                    (provider.name && provider.name.toLowerCase().includes(q)),
                )
              })

              return (
                <div class="flex flex-col gap-2">
                  {/* Provider 头部（无边框，极简清爽） */}
                  <div class="flex items-center justify-between gap-3 px-1 pb-1">
                    <div class="flex items-center gap-2.5 min-w-0">
                      <ProviderIcon id={providerID} class="size-4 shrink-0 icon-strong-base" />
                      <span class="text-14-medium text-text-strong truncate">
                        {provider.name || providerID}
                      </span>
                      <span class="text-12-regular text-text-subtle font-mono">
                        {providerID}
                      </span>
                      <span class="text-12-regular text-text-weak">
                        ({allModels().length})
                      </span>
                      <Show when={provider.npm}>
                        <span class="text-11-regular text-text-subtle font-mono hidden sm:inline">
                          {provider.npm}
                        </span>
                      </Show>
                    </div>

                    <div class="flex items-center gap-1 shrink-0">
                      <Button
                        size="small"
                        variant="secondary"
                        icon="plus-small"
                        onClick={() => addModel(providerID)}
                      >
                        添加模型
                      </Button>
                      <IconButton
                        icon="edit"
                        variant="ghost"
                        onClick={() => editProvider(providerID, provider)}
                        title="编辑提供商配置"
                      />
                      <IconButton
                        icon="trash"
                        variant="ghost"
                        onClick={() => deleteProvider(providerID, provider.name || providerID)}
                        title="删除提供商"
                      />
                    </div>
                  </div>

                  {/* Base URL 提示 */}
                  <Show when={provider.options?.baseURL}>
                    {(url) => (
                      <div class="text-11-regular text-text-subtle px-1 pb-1 font-mono truncate">
                        Base URL: {url()}
                      </div>
                    )}
                  </Show>

                  {/* 该 Provider 下的模型列表（纯原生 SettingsList，无厚重外边框） */}
                  <Show
                    when={filteredModels().length > 0}
                    fallback={
                      <div class="py-4 text-center text-13-regular text-text-weak bg-surface-base rounded-lg">
                        暂无模型，点击右上角「添加模型」配置。
                      </div>
                    }
                  >
                    <SettingsList>
                      <For each={filteredModels()}>
                        {([modelID, m]) => {
                          const key = { providerID, modelID }
                          const variantCount = () =>
                            m.variants ? Object.keys(m.variants).length : 0

                          return (
                            <div class="flex items-center justify-between gap-4 py-2.5 border-b border-border-weak-base/40 last:border-none group">
                              {/* 模型基本信息与精简徽标 */}
                              <div class="flex items-center gap-3 min-w-0 flex-1">
                                <div class="flex items-baseline gap-2 min-w-0">
                                  <span class="text-14-medium text-text-strong truncate">
                                    {m.name || modelID}
                                  </span>
                                  <span class="text-12-regular font-mono text-text-subtle truncate">
                                    {modelID}
                                  </span>
                                </div>

                                {/* 精简微标（去掉冗长文字堆砌） */}
                                <div class="flex items-center gap-1.5 shrink-0">
                                  <Show when={m.limit?.context}>
                                    <span class="text-11-regular px-1.5 py-0.5 rounded bg-surface-weak-base text-text-weak">
                                      {formatTokenLimit(m.limit?.context)}
                                    </span>
                                  </Show>
                                  <Show when={m.reasoning}>
                                    <span class="text-11-medium px-1.5 py-0.5 rounded bg-primary-base/10 text-text-interactive-base">
                                      推理{variantCount() > 0 ? ` (${variantCount()})` : ""}
                                    </span>
                                  </Show>
                                  <Show when={m.tool_call}>
                                    <span class="text-11-regular px-1.5 py-0.5 rounded bg-surface-weak-base text-text-subtle">
                                      工具
                                    </span>
                                  </Show>
                                  <Show when={m.attachment}>
                                    <span class="text-11-regular px-1.5 py-0.5 rounded bg-surface-weak-base text-text-subtle">
                                      视觉
                                    </span>
                                  </Show>
                                </div>
                              </div>

                              {/* 右侧操作区 */}
                              <div class="flex items-center gap-1 shrink-0">
                                <IconButton
                                  icon="edit"
                                  variant="ghost"
                                  onClick={() => editModel(providerID, modelID, m)}
                                  title="编辑模型"
                                />
                                <IconButton
                                  icon="copy"
                                  variant="ghost"
                                  onClick={() => cloneModel(providerID, modelID, m)}
                                  title="克隆模型"
                                />
                                <IconButton
                                  icon="trash"
                                  variant="ghost"
                                  onClick={() => deleteModel(providerID, modelID, m.name || modelID)}
                                  title="删除模型"
                                />
                                <div class="pl-1.5 ml-0.5">
                                  <Switch
                                    checked={models.visible(key)}
                                    onChange={(checked) => models.setVisibility(key, checked)}
                                    title={models.visible(key) ? "在对话输入框中显示" : "已隐藏"}
                                    hideLabel
                                  >
                                    {m.name || modelID}
                                  </Switch>
                                </div>
                              </div>
                            </div>
                          )
                        }}
                      </For>
                    </SettingsList>
                  </Show>
                </div>
              )
            }}
          </For>
        </Show>
      </div>
    </div>
  )
}
