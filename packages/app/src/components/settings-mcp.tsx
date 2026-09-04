import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Switch } from "@opencode-ai/ui/switch"
import { Tag } from "@opencode-ai/ui/tag"
import { TextField } from "@opencode-ai/ui/text-field"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { type Component, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import type { Config } from "@opencode-ai/sdk/v2"
import { DialogConfirmAction } from "./dialog-model-config"
import { DialogMcpConfig, type McpServerConfig } from "./dialog-mcp-config"
import { DialogSettings } from "./dialog-settings"
import { SettingsList } from "./settings-list"
import { SettingsServerPicker, SettingsServerScope } from "./settings-server-picker"

export const SettingsMcp: Component = () => {
  return (
    <SettingsServerScope>
      <SettingsMcpContent />
    </SettingsServerScope>
  )
}

const SettingsMcpContent: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()

  // 安全异步获取当前服务器上的 MCP 运行状态
  const [runtimeStatusMap, { refetch: refetchStatus }] = createResource(
    () => serverSDK().client,
    async (client) => {
      try {
        const res = await client.mcp.status()
        return res.data ?? {}
      } catch {
        return {}
      }
    },
  )

  const [search, setSearch] = createSignal("")

  // 从本地 opencode.json 配置中读取 mcp 字典 (与 SettingsAgents / SettingsModels 保持完全一致)
  const configuredMcps = createMemo<Record<string, McpServerConfig>>(() => {
    return (serverSync().data.config.mcp as Record<string, McpServerConfig>) ?? {}
  })

  // 搜索过滤后的 MCP 列表
  const filteredMcps = createMemo<Array<[string, McpServerConfig]>>(() => {
    const raw = Object.entries(configuredMcps()).filter((entry): entry is [string, McpServerConfig] => !!entry[1])
    const q = search().trim().toLowerCase()
    if (!q) return raw

    return raw.filter(([name, cfg]) => {
      const matchName = name.toLowerCase().includes(q)
      const matchType = cfg.type && cfg.type.toLowerCase().includes(q)
      const matchCmd = cfg.type === "local" && cfg.command && cfg.command.join(" ").toLowerCase().includes(q)
      const matchUrl = cfg.type === "remote" && cfg.url && cfg.url.toLowerCase().includes(q)
      return matchName || matchType || matchCmd || matchUrl
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

  // 返回 MCP 设置页
  const backToMcp = () => {
    dialog.show(() => <DialogSettings defaultValue="mcp" />)
  }

  // 添加 MCP 服务器
  const addMcp = () => {
    dialog.show(() => <DialogMcpConfig onBack={backToMcp} />)
  }

  // 编辑 MCP 服务器
  const editMcp = (name: string, cfg: McpServerConfig) => {
    dialog.show(() => (
      <DialogMcpConfig
        name={name}
        initial={{
          name,
          type: cfg.type,
          command: cfg.type === "local" ? cfg.command : undefined,
          url: cfg.type === "remote" ? cfg.url : undefined,
          cwd: cfg.type === "local" ? cfg.cwd : undefined,
          environment: cfg.type === "local" ? cfg.environment : undefined,
          headers: cfg.type === "remote" ? cfg.headers : undefined,
          timeout: cfg.timeout,
          enabled: cfg.enabled !== false,
        }}
        onBack={backToMcp}
      />
    ))
  }

  // 克隆 MCP 服务器
  const cloneMcp = (name: string, cfg: McpServerConfig) => {
    const cloneName = `${name}-copy`
    dialog.show(() => (
      <DialogMcpConfig
        name={cloneName}
        initial={{
          name: cloneName,
          type: cfg.type,
          command: cfg.type === "local" ? cfg.command : undefined,
          url: cfg.type === "remote" ? cfg.url : undefined,
          cwd: cfg.type === "local" ? cfg.cwd : undefined,
          environment: cfg.type === "local" ? cfg.environment : undefined,
          headers: cfg.type === "remote" ? cfg.headers : undefined,
          timeout: cfg.timeout,
          enabled: cfg.enabled !== false,
        }}
        onBack={backToMcp}
      />
    ))
  }

  // 删除 MCP 服务器
  const deleteMcp = (name: string) => {
    dialog.show(() => (
      <DialogConfirmAction
        title="删除 MCP 服务器"
        description={`确定要删除 MCP 服务器「${name}」吗？此操作将立即从本地配置中移除并生效。`}
        danger
        confirmText="确认删除"
        onClose={backToMcp}
        onConfirm={async () => {
          const current = serverSync().data.config
          const nextMap: NonNullable<Config["mcp"]> = { ...(current.mcp ?? {}) }
          delete nextMap[name]

          await serverSync().updateConfig({ mcp: nextMap })
          try {
            await serverSDK().client.mcp.disconnect({ name })
          } catch {}
          refetchStatus()
          showToast({
            variant: "success",
            icon: "circle-check",
            title: "MCP 服务器已删除",
            description: `服务器「${name}」已从本地配置移除并生效。`,
          })
          backToMcp()
        }}
      />
    ))
  }

  // 快捷切换 MCP 启用 / 停用状态
  const toggleMcpEnabled = async (name: string, currentEnabled: boolean | undefined) => {
    try {
      const current: NonNullable<Config["mcp"]> = { ...(serverSync().data.config.mcp ?? {}) }
      const existing = current[name]
      if (!existing) return

      const nextEnabled = currentEnabled === false ? true : false
      current[name] = {
        ...existing,
        enabled: nextEnabled,
      }

      await serverSync().updateConfig({ mcp: current })
      showToast({
        variant: "success",
        icon: "circle-check",
        title: nextEnabled ? `已启用 MCP 服务器 ${name}` : `已停用 MCP 服务器 ${name}`,
        description: "本地配置已实时生效。",
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      showToast({ variant: "error", title: "更新 MCP 状态失败", description: msg })
    }
  }

  const mcpCount = () => Object.keys(configuredMcps()).length

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      {/* 顶部 Sticky 工具栏：与模型、代理和权限页面 100% 对齐 */}
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-4 pt-6 pb-5 max-w-[800px]">
          <div class="flex items-center justify-between gap-4">
            <div class="flex items-baseline gap-2.5">
              <h2 class="text-16-medium text-text-strong">{language.t("settings.mcp.title")}</h2>
              <span class="text-12-regular text-text-subtle">模型上下文协议 (Model Context Protocol) 扩展</span>
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
              <Button size="normal" variant="primary" icon="plus-small" onClick={addMcp}>
                添加 MCP
              </Button>
              <SettingsServerPicker />
            </div>
          </div>

          {/* 搜索框：与代理、权限页面 100% 相同 */}
          <div class="flex items-center gap-2 px-3 h-9 rounded-lg bg-surface-base border border-transparent focus-within:border-border-weak-base transition-colors">
            <Icon name="magnifying-glass" class="text-icon-weak-base flex-shrink-0" />
            <TextField
              variant="ghost"
              type="text"
              value={search()}
              onChange={setSearch}
              placeholder="搜索 MCP 服务器名称、类型、命令或 URL..."
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              class="w-full text-13-regular bg-transparent border-none p-0 focus:ring-0 focus:outline-none placeholder:text-text-weaker"
            />
          </div>
        </div>
      </div>

      {/* 主体列表内容 */}
      <div class="flex flex-col gap-3 max-w-[800px]">
        <Show
          when={filteredMcps().length > 0}
          fallback={
            <div class="flex flex-col items-center justify-center py-16 text-center">
              <div class="w-12 h-12 rounded-full bg-surface-base flex items-center justify-center text-icon-subtle mb-3">
                <Icon name="mcp" />
              </div>
              <p class="text-14-medium text-text-base mb-1">
                {search() ? "未找到匹配的 MCP 服务器" : "未配置 MCP 服务器"}
              </p>
              <p class="text-12-regular text-text-subtle max-w-sm mb-4">
                {search()
                  ? "尝试更换搜索关键字，或清除搜索框。"
                  : "通过添加 MCP 服务器，为智能体扩展外部工具、命令行工具链与企业知识库。"}
              </p>
              <Show when={!search()}>
                <Button size="normal" variant="primary" icon="plus" onClick={addMcp}>
                  添加第一个 MCP 服务器
                </Button>
              </Show>
            </div>
          }
        >
          <SettingsList>
            <For each={filteredMcps()}>
              {([name, cfg]) => {
                const isEnabled = () => cfg.enabled !== false
                // 从当前服务器异步状态读取
                const runtimeStatus = () => runtimeStatusMap()?.[name]

                // 计算环境变量或请求头计数
                const extraCount = () => {
                  if (cfg.type === "local") {
                    const keys = Object.keys(cfg.environment ?? {})
                    return keys.length > 0 ? `${keys.length} 环境变量` : null
                  }
                  if (cfg.type === "remote") {
                    const keys = Object.keys(cfg.headers ?? {})
                    return keys.length > 0 ? `${keys.length} 请求头` : null
                  }
                  return null
                }

                const commandDisplay = () => {
                  if (cfg.type === "local") {
                    return cfg.command?.join(" ") || "未指定命令"
                  }
                  return cfg.url || "未指定 URL"
                }

                const runtimeError = () => {
                  const s = runtimeStatus()
                  if (!s) return undefined
                  if ("error" in s && typeof (s as { error?: string }).error === "string") {
                    return (s as { error: string }).error
                  }
                  return undefined
                }

                return (
                  <div class="group flex items-center justify-between p-3.5 hover:bg-surface-base-hover/40 transition-colors">
                    {/* 左侧信息栏：自然上下两行排列 */}
                    <div class="flex flex-col gap-1 min-w-0 pr-4">
                      {/* 第 1 行：名称 + 类型 + 状态 */}
                      <div class="flex items-center gap-2 flex-wrap">
                        <span class="text-13-medium text-text-strong">{name}</span>
                        <Tag class="text-10-regular text-text-weak bg-surface-base border-border-base/50">
                          {cfg.type === "local" ? "本地进程 (stdio)" : "远程端点 (sse)"}
                        </Tag>

                        {/* 运行状态指示 */}
                        <Show when={runtimeStatus()}>
                          {(status) => {
                            const s = status().status
                            if (s === "connected") {
                              return (
                                <span class="flex items-center gap-1 text-11-regular text-emerald-400">
                                  <span class="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                                  已连接
                                </span>
                              )
                            }
                            if (s === "failed") {
                              return (
                                <span class="flex items-center gap-1 text-11-regular text-red-400">
                                  <span class="w-1.5 h-1.5 rounded-full bg-red-500" />
                                  连接失败
                                </span>
                              )
                            }
                            if (s === "needs_auth") {
                              return (
                                <span class="flex items-center gap-1 text-11-regular text-amber-400">
                                  <span class="w-1.5 h-1.5 rounded-full bg-amber-500" />
                                  需要授权
                                </span>
                              )
                            }
                            if (s === "disabled") {
                              return (
                                <span class="flex items-center gap-1 text-11-regular text-text-subtle">
                                  <span class="w-1.5 h-1.5 rounded-full bg-text-subtle/50" />
                                  已禁用
                                </span>
                              )
                            }
                            return null
                          }}
                        </Show>

                        <Show when={!isEnabled()}>
                          <Tag class="text-10-regular text-text-subtle bg-surface-base border-border-base/30">
                            已停用
                          </Tag>
                        </Show>
                      </div>

                      {/* 第 2 行：命令行 / URL 详细参数 */}
                      <div class="flex items-center gap-2 text-11-regular text-text-subtle font-mono truncate">
                        <span class="truncate max-w-[460px]" title={commandDisplay()}>
                          {commandDisplay()}
                        </span>
                        <Show when={extraCount()}>
                          <span class="shrink-0 px-1.5 py-0.2 text-10-regular bg-surface-base rounded border border-border-base/40 text-text-weak">
                            {extraCount()}
                          </span>
                        </Show>
                        <Show when={cfg.timeout}>
                          <span class="shrink-0 text-text-weaker font-sans">{cfg.timeout}ms</span>
                        </Show>
                      </div>

                      {/* 若有运行时错误信息，展示错误摘要 */}
                      <Show when={runtimeError()}>
                        <div class="text-11-regular text-text-critical truncate max-w-[460px]">{runtimeError()}</div>
                      </Show>
                    </div>

                    {/* 右侧操作栏：Hover 渐入按钮 + Switch 开关 */}
                    <div class="flex items-center gap-2 shrink-0">
                      <div class="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
                        <IconButton
                          icon="edit-small-2"
                          size="small"
                          variant="ghost"
                          title="编辑 MCP 服务器"
                          onClick={() => editMcp(name, cfg)}
                        />
                        <IconButton
                          icon="fork"
                          size="small"
                          variant="ghost"
                          title="克隆 MCP 服务器"
                          onClick={() => cloneMcp(name, cfg)}
                        />
                        <IconButton
                          icon="trash"
                          size="small"
                          variant="ghost"
                          title="删除 MCP 服务器"
                          onClick={() => deleteMcp(name)}
                        />
                      </div>
                      <Switch checked={isEnabled()} onChange={() => toggleMcpEnabled(name, cfg.enabled)} />
                    </div>
                  </div>
                )
              }}
            </For>
          </SettingsList>
        </Show>
      </div>
    </div>
  )
}
