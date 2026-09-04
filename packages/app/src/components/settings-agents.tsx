import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Switch } from "@opencode-ai/ui/switch"
import { Tag } from "@opencode-ai/ui/tag"
import { TextField } from "@opencode-ai/ui/text-field"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { type Component, createMemo, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import type { AgentConfig } from "@opencode-ai/sdk/v2"
import { DialogAgentConfig, DialogConfirmAction } from "./dialog-model-config"
import { DialogSettings } from "./dialog-settings"
import { SettingsList } from "./settings-list"
import { SettingsServerPicker, SettingsServerScope } from "./settings-server-picker"

function formatShortModel(modelStr?: string): string {
  if (!modelStr) return ""
  const slash = modelStr.indexOf("/")
  return slash >= 0 ? modelStr.slice(slash + 1) : modelStr
}

export const SettingsAgents: Component = () => {
  return (
    <SettingsServerScope>
      <SettingsAgentsContent />
    </SettingsServerScope>
  )
}

const SettingsAgentsContent: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()

  const [search, setSearch] = createSignal("")

  // 从本地 opencode.json 配置中读取 agent 字典
  const configuredAgents = createMemo(() => {
    return serverSync().data.config.agent ?? {}
  })

  // 搜索过滤后的代理列表
  const filteredAgents = createMemo<Array<[string, AgentConfig]>>(() => {
    const raw = Object.entries(configuredAgents()).filter(
      (entry): entry is [string, AgentConfig] => !!entry[1],
    )
    const q = search().trim().toLowerCase()
    if (!q) return raw

    return raw.filter(([id, a]) => {
      const matchID = id.toLowerCase().includes(q)
      const matchDesc = a.description && a.description.toLowerCase().includes(q)
      const matchModel = a.model && a.model.toLowerCase().includes(q)
      const matchMode = a.mode && a.mode.toLowerCase().includes(q)
      return matchID || matchDesc || matchModel || matchMode
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

  // 返回代理设置页
  const backToAgents = () => {
    dialog.show(() => <DialogSettings defaultValue="agents" />)
  }

  // 添加代理
  const addAgent = () => {
    dialog.show(() => <DialogAgentConfig onBack={backToAgents} />)
  }

  // 编辑代理
  const editAgent = (agentID: string, a: AgentConfig) => {
    dialog.show(() => (
      <DialogAgentConfig
        agentID={agentID}
        initial={{
          name: agentID,
          description: a.description,
          model: a.model,
          variant: a.variant,
          mode: a.mode,
          prompt: a.prompt,
          steps: a.steps,
          temperature: a.temperature,
          top_p: a.top_p,
          hidden: a.hidden,
          disable: a.disable,
        }}
        onBack={backToAgents}
      />
    ))
  }

  // 克隆代理
  const cloneAgent = (agentID: string, a: AgentConfig) => {
    dialog.show(() => (
      <DialogAgentConfig
        agentID={`${agentID}-copy`}
        initial={{
          name: `${agentID}-copy`,
          description: a.description ? `${a.description} (副本)` : undefined,
          model: a.model,
          variant: a.variant,
          mode: a.mode,
          prompt: a.prompt,
          steps: a.steps,
          temperature: a.temperature,
          top_p: a.top_p,
          hidden: a.hidden,
          disable: a.disable,
        }}
        onBack={backToAgents}
      />
    ))
  }

  // 删除代理
  const deleteAgent = (agentID: string) => {
    dialog.show(() => (
      <DialogConfirmAction
        title="删除代理"
        description={`确定要删除代理「${agentID}」吗？此操作将立即从本地配置中移除并生效。`}
        danger
        confirmText="确认删除"
        onClose={backToAgents}
        onConfirm={async () => {
          const current = serverSync().data.config
          const agents = { ...(current.agent ?? {}) }
          delete agents[agentID]
          await serverSync().updateConfig({ agent: agents })
          showToast({
            variant: "success",
            icon: "circle-check",
            title: "代理已删除",
            description: `代理「${agentID}」已从本地配置移除并生效。`,
          })
          backToAgents()
        }}
      />
    ))
  }

  // 快捷切换代理启用 / 停用状态
  const toggleAgentDisabled = async (agentID: string, currentDisable: boolean | undefined) => {
    try {
      const current = serverSync().data.config
      const agents = { ...(current.agent ?? {}) }
      const existing = agents[agentID]
      if (!existing) return

      const nextDisable = !currentDisable
      agents[agentID] = {
        ...existing,
        disable: nextDisable ? true : undefined,
      }

      await serverSync().updateConfig({ agent: agents })
      showToast({
        variant: "success",
        icon: "circle-check",
        title: nextDisable ? `已停用代理 ${agentID}` : `已启用代理 ${agentID}`,
        description: "本地配置已实时生效。",
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      showToast({ variant: "error", title: "更新代理状态失败", description: msg })
    }
  }

  const agentCount = () => Object.keys(configuredAgents()).length

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      {/* 顶部 Sticky 工具栏：与模型页面 100% 对齐 */}
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-4 pt-6 pb-5 max-w-[800px]">
          <div class="flex items-center justify-between gap-4">
            <div class="flex items-baseline gap-2.5">
              <h2 class="text-16-medium text-text-strong">{language.t("settings.agents.title")}</h2>
              <span class="text-12-regular text-text-subtle">本地代理与关联模型</span>
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
              <Button size="normal" variant="primary" icon="plus-small" onClick={addAgent}>
                添加代理
              </Button>
              <SettingsServerPicker />
            </div>
          </div>

          {/* 搜索框 */}
          <div class="flex items-center gap-2 px-3 h-9 rounded-lg bg-surface-base border border-transparent focus-within:border-border-weak-base transition-colors">
            <Icon name="magnifying-glass" class="text-icon-weak-base flex-shrink-0" />
            <TextField
              variant="ghost"
              type="text"
              value={search()}
              onChange={setSearch}
              placeholder="搜索代理名称、职责描述或模型..."
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              class="flex-1 text-13-regular"
            />
            <Show when={search()}>
              <IconButton icon="circle-x" variant="ghost" onClick={() => setSearch("")} />
            </Show>
          </div>
        </div>
      </div>

      {/* 主内容区域：与模型页面结构、边距及规范 100% 一致 */}
      <div class="flex flex-col gap-6 max-w-[800px]">
        <Show
          when={agentCount() > 0}
          fallback={
            <div class="flex flex-col items-center justify-center py-12 px-4 rounded-xl border border-dashed border-border-weak-base text-center bg-surface-base/50">
              <Icon name="subagent" class="size-8 text-icon-weak-base mb-3" />
              <span class="text-15-medium text-text-strong">
                {search() ? "未找到匹配的代理" : "尚未配置任何代理"}
              </span>
              <p class="text-13-regular text-text-weak mt-1 mb-5 max-w-md">
                为特定任务定义专长代理，并为它们绑定特定的模型、提示词与思考变体。
              </p>
              <Show when={!search()}>
                <Button variant="primary" icon="plus" onClick={addAgent}>
                  添加第一个代理
                </Button>
              </Show>
            </div>
          }
        >
          <div class="flex flex-col gap-2">
            {/* 列表顶部元数据信息栏 */}
            <div class="flex items-center justify-between gap-3 px-1 pt-1">
              <div class="flex items-center gap-2 min-w-0">
                <Icon name="brain" class="size-4 shrink-0 text-text-base" />
                <span class="text-13-medium text-text-strong">已配置代理</span>
                <span class="text-12-regular text-text-subtle">·</span>
                <span class="text-11-regular text-text-subtle">
                  {filteredAgents().length} 个代理
                </span>
              </div>

              <div class="flex items-center gap-0.5 shrink-0">
                <Button
                  size="small"
                  variant="ghost"
                  icon="plus-small"
                  onClick={addAgent}
                  class="text-12-regular"
                >
                  添加代理
                </Button>
              </div>
            </div>

            {/* 该分组下的代理列表 */}
            <Show
              when={filteredAgents().length > 0}
              fallback={
                <div class="py-4 text-center text-13-regular text-text-weak bg-surface-base rounded-lg">
                  未找到匹配「{search()}」的代理。
                </div>
              }
            >
              <SettingsList>
                <For each={filteredAgents()}>
                  {([id, a]) => {
                    const isDisabled = () => !!a.disable
                    const shortModel = () => formatShortModel(a.model)

                    return (
                      <div
                        class={`flex items-center justify-between gap-4 py-2 px-2 -mx-2 rounded-md border-b border-border-weak-base/20 last:border-none hover:bg-surface-base-hover/40 transition-colors group ${
                          isDisabled() ? "opacity-50" : ""
                        }`}
                      >
                        {/* 左侧：代理名称 + 关联模型与变体（第 1 行） + 职责描述（第 2 行） */}
                        <div class="flex flex-col min-w-0 flex-1 pr-4">
                          <div class="flex items-center gap-2 flex-wrap">
                            <span
                              class="text-13-medium text-text-strong truncate"
                              title={id}
                            >
                              {id}
                            </span>

                            {/* 绑定的模型与变体：紧随代理名称，自然流畅 */}
                            <Show when={a.model}>
                              <div class="flex items-center gap-1.5 shrink-0">
                                <span
                                  class="text-11-regular font-mono text-text-weak"
                                  title={`绑定的模型: ${a.model}`}
                                >
                                  {shortModel()}
                                </span>
                                <Show when={a.variant}>
                                  <span
                                    class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface-raised-base border border-border-weak-base/40 shrink-0 select-none text-text-subtle"
                                    title={`思考变体: ${a.variant}`}
                                  >
                                    <Icon name="brain" size="small" class="size-3 text-icon-base" />
                                    <span class="font-mono text-10-regular text-text-base leading-none">
                                      {a.variant}
                                    </span>
                                  </span>
                                </Show>
                              </div>
                            </Show>

                            <Show when={a.mode === "primary"}>
                              <span class="text-10-regular text-text-subtle font-mono">
                                (primary)
                              </span>
                            </Show>
                            <Show when={a.mode === "all"}>
                              <span class="text-10-regular text-text-subtle font-mono">
                                (all)
                              </span>
                            </Show>
                          </div>

                          {/* 描述放第二行，柔和清晰 */}
                          <Show when={a.description}>
                            <span
                              class="text-12-regular text-text-weak truncate max-w-sm sm:max-w-md pt-0.5"
                              title={a.description}
                            >
                              {a.description}
                            </span>
                          </Show>
                        </div>

                        {/* 右侧：纯粹的操作控制区（辅助图标 + Hover 淡入按钮 + Switch） */}
                        <div class="flex items-center gap-2 shrink-0">
                          {/* 辅助状态指示（提示词、隐藏状态） */}
                          <div class="flex items-center gap-1 shrink-0">
                            <Show when={a.prompt}>
                              <span
                                class="inline-flex items-center text-icon-base hover:text-text-strong transition-colors select-none"
                                title="已配置自定义系统提示词"
                              >
                                <Icon name="prompt" size="small" class="size-3.5" />
                              </span>
                            </Show>
                            <Show when={a.hidden}>
                              <span
                                class="inline-flex items-center text-icon-base hover:text-text-strong transition-colors select-none"
                                title="在 @ 菜单中隐藏"
                              >
                                <Icon name="glasses" size="small" class="size-3.5" />
                              </span>
                            </Show>
                          </div>

                          {/* 操作按钮组（Hover 淡入） */}
                          <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                            <IconButton
                              icon="edit"
                              variant="ghost"
                              onClick={() => editAgent(id, a)}
                              title="编辑代理"
                            />
                            <IconButton
                              icon="copy"
                              variant="ghost"
                              onClick={() => cloneAgent(id, a)}
                              title="克隆代理"
                            />
                            <IconButton
                              icon="trash"
                              variant="ghost"
                              onClick={() => deleteAgent(id)}
                              title="删除代理"
                            />
                          </div>

                          {/* 快捷启用 / 停用 Switch */}
                          <div class="shrink-0">
                            <Switch
                              checked={!isDisabled()}
                              onChange={() => toggleAgentDisabled(id, a.disable)}
                              title={isDisabled() ? "已停用 (点击启用)" : "已启用 (点击停用)"}
                              hideLabel
                            >
                              {id}
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
        </Show>
      </div>
    </div>
  )
}
