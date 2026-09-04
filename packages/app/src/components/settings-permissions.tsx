import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Select } from "@opencode-ai/ui/select"
import { Tag } from "@opencode-ai/ui/tag"
import { TextField } from "@opencode-ai/ui/text-field"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { type Component, createMemo, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { DialogConfirmAction } from "./dialog-model-config"
import { DialogPermissionConfig, type PermissionAction } from "./dialog-permission-config"
import { DialogSettings } from "./dialog-settings"
import { SettingsList } from "./settings-list"
import { SettingsServerPicker, SettingsServerScope } from "./settings-server-picker"

interface ToolMeta {
  id: string
  title: string
  description: string
  icon: "terminal" | "folder" | "edit" | "link" | "subagent" | "brain" | "circle-check" | "prompt" | "magnifying-glass" | "file-tree" | "code" | "shield"
  defaultAction: PermissionAction
}

const KNOWN_TOOLS: Record<string, ToolMeta> = {
  bash: {
    id: "bash",
    title: "运行命令行",
    description: "执行 shell、系统命令与终端工具（支持命令模式通配符）",
    icon: "terminal",
    defaultAction: "ask",
  },
  external_directory: {
    id: "external_directory",
    title: "外部目录",
    description: "读取或访问项目工作区根目录之外的文件路径",
    icon: "folder",
    defaultAction: "ask",
  },
  edit: {
    id: "edit",
    title: "修改文件",
    description: "写入、编辑、替换与修补项目文件",
    icon: "edit",
    defaultAction: "ask",
  },
  read: {
    id: "read",
    title: "读取文件",
    description: "读取文件并加载内容至会话历史",
    icon: "folder",
    defaultAction: "allow",
  },
  webfetch: {
    id: "webfetch",
    title: "网页抓取",
    description: "通过 HTTP/HTTPS 从外部 URL 获取网页与接口数据",
    icon: "link",
    defaultAction: "ask",
  },
  websearch: {
    id: "websearch",
    title: "网页搜索",
    description: "通过搜索引擎检索外部网络信息与技术文档",
    icon: "link",
    defaultAction: "ask",
  },
  task: {
    id: "task",
    title: "派发子智能体",
    description: "启动并调度专业子代理（如 Sol、Worker、Grok 等）并发执行",
    icon: "brain",
    defaultAction: "allow",
  },
  skill: {
    id: "skill",
    title: "技能系统",
    description: "根据任务需要动态加载与调用专业 Agent Skill",
    icon: "brain",
    defaultAction: "allow",
  },
  todowrite: {
    id: "todowrite",
    title: "待办清单",
    description: "创建、更新与维护任务执行计划与待办状态",
    icon: "circle-check",
    defaultAction: "allow",
  },
  question: {
    id: "question",
    title: "向用户提问",
    description: "在需要澄清需求或选择实现方案时主动向用户发问",
    icon: "prompt",
    defaultAction: "allow",
  },
  glob: {
    id: "glob",
    title: "文件通配检索",
    description: "使用 glob 表达式快速匹配和定位文件路径",
    icon: "magnifying-glass",
    defaultAction: "allow",
  },
  grep: {
    id: "grep",
    title: "正则全文搜索",
    description: "使用正则表达式在项目中快速搜索匹配内容",
    icon: "magnifying-glass",
    defaultAction: "allow",
  },
  list: {
    id: "list",
    title: "目录浏览",
    description: "列出目录中的文件结构与文件树",
    icon: "file-tree",
    defaultAction: "allow",
  },
  lsp: {
    id: "lsp",
    title: "语言服务器",
    description: "运行代码语法树、符号定义与诊断查询",
    icon: "code",
    defaultAction: "allow",
  },
  doom_loop: {
    id: "doom_loop",
    title: "死循环熔断",
    description: "检测具有相同参数的重复工具调用并进行安全熔断",
    icon: "shield",
    defaultAction: "ask",
  },
}

const ACTION_OPTIONS: Array<{ value: PermissionAction; label: string }> = [
  { value: "allow", label: "允许 (allow)" },
  { value: "ask", label: "询问 (ask)" },
  { value: "deny", label: "拒绝 (deny)" },
]

export const SettingsPermissions: Component = () => {
  return (
    <SettingsServerScope>
      <SettingsPermissionsContent />
    </SettingsServerScope>
  )
}

const SettingsPermissionsContent: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()

  const [search, setSearch] = createSignal("")
  const [ruleFilters, setRuleFilters] = createSignal<Record<string, string>>({})
  const [newPatterns, setNewPatterns] = createSignal<Record<string, string>>({})
  const [newActions, setNewActions] = createSignal<Record<string, PermissionAction>>({})
  const [showAddPatternFor, setShowAddPatternFor] = createSignal<Record<string, boolean>>({})

  // 直接且仅从本地配置读取 permission 字典（唯一真实来源）
  const configuredPermission = createMemo(() => {
    const raw = serverSync().data.config.permission
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as Record<string, unknown>
    }
    if (typeof raw === "string") {
      return { "*": raw }
    }
    return {}
  })

  // 本地配置中实际声明的工具项列表
  const configuredEntries = createMemo<Array<[string, unknown]>>(() => {
    const perm = configuredPermission()
    const entries = Object.entries(perm)
    const q = search().trim().toLowerCase()
    if (!q) return entries

    return entries.filter(([key, val]) => {
      const meta = KNOWN_TOOLS[key]
      const matchKey = key.toLowerCase().includes(q)
      const matchTitle = meta?.title.toLowerCase().includes(q)
      const matchDesc = meta?.description.toLowerCase().includes(q)
      let matchRule = false
      if (val && typeof val === "object" && !Array.isArray(val)) {
        matchRule = Object.keys(val).some((k) => k.toLowerCase().includes(q))
      }
      return matchKey || matchTitle || matchDesc || matchRule
    })
  })

  // 区分细粒度模式规则组与单一动作工具
  const multiRuleEntries = createMemo(() => {
    return configuredEntries().filter(
      ([, val]) => val && typeof val === "object" && !Array.isArray(val),
    )
  })

  const singleActionEntries = createMemo(() => {
    return configuredEntries().filter(
      ([, val]) => typeof val === "string" || !val || Array.isArray(val),
    )
  })

  // 未在配置中声明的常用工具（供快捷添加）
  const unconfiguredTools = createMemo<ToolMeta[]>(() => {
    const perm = configuredPermission()
    return Object.values(KNOWN_TOOLS).filter((tool) => perm[tool.id] === undefined)
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

  // 返回权限设置页
  const backToPermissions = () => {
    dialog.show(() => <DialogSettings defaultValue="permissions" />)
  }

  // 打开添加规则弹窗
  const openAddDialog = (toolID?: string) => {
    dialog.show(() => <DialogPermissionConfig toolID={toolID} onBack={backToPermissions} />)
  }

  // 更新整个工具的单一动作
  const updateToolAction = async (toolID: string, action: PermissionAction) => {
    try {
      const current = { ...configuredPermission() }
      current[toolID] = action

      await serverSync().updateConfig({ permission: current as never })
      showToast({
        variant: "success",
        icon: "circle-check",
        title: `已更新权限: ${toolID}`,
        description: `已设置为「${action}」并实时生效。`,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      showToast({ variant: "error", title: "更新失败", description: msg })
    }
  }

  // 更新模式规则字典中的单条规则动作（严格保持原始键序）
  const updatePatternRuleAction = async (toolID: string, pattern: string, action: PermissionAction) => {
    try {
      const current = { ...configuredPermission() }
      const existingObj = current[toolID]
      if (!existingObj || typeof existingObj !== "object" || Array.isArray(existingObj)) return

      const updatedObj: Record<string, string> = {}
      for (const [k, v] of Object.entries(existingObj)) {
        updatedObj[k] = k === pattern ? action : (v as string)
      }

      current[toolID] = updatedObj
      await serverSync().updateConfig({ permission: current as never })
      showToast({
        variant: "success",
        icon: "circle-check",
        title: "规则已更新",
        description: `「${pattern}」已设置为 ${action}`,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      showToast({ variant: "error", title: "更新失败", description: msg })
    }
  }

  // 删除模式规则字典中的某条规则
  const deletePatternRule = async (toolID: string, pattern: string) => {
    try {
      const current = { ...configuredPermission() }
      const existingObj = current[toolID]
      if (!existingObj || typeof existingObj !== "object" || Array.isArray(existingObj)) return

      const updatedObj: Record<string, string> = {}
      for (const [k, v] of Object.entries(existingObj)) {
        if (k !== pattern) {
          updatedObj[k] = v as string
        }
      }

      current[toolID] = updatedObj
      await serverSync().updateConfig({ permission: current as never })
      showToast({
        variant: "success",
        icon: "circle-check",
        title: "规则已删除",
        description: `已移除规则「${pattern}」`,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      showToast({ variant: "error", title: "删除失败", description: msg })
    }
  }

  // 向模式规则字典中追加新规则
  const addPatternRule = async (toolID: string) => {
    const pattern = (newPatterns()[toolID] ?? "").trim()
    const action = newActions()[toolID] ?? "ask"

    if (!pattern) {
      showToast({ variant: "error", title: "请输入匹配模式" })
      return
    }

    try {
      const current = { ...configuredPermission() }
      const existingObj = current[toolID]
      let updatedObj: Record<string, string> = {}

      if (existingObj && typeof existingObj === "object" && !Array.isArray(existingObj)) {
        updatedObj = { ...(existingObj as Record<string, string>), [pattern]: action }
      } else {
        updatedObj = { [pattern]: action }
      }

      current[toolID] = updatedObj
      await serverSync().updateConfig({ permission: current as never })

      setNewPatterns((prev) => ({ ...prev, [toolID]: "" }))
      setShowAddPatternFor((prev) => ({ ...prev, [toolID]: false }))
      showToast({
        variant: "success",
        icon: "circle-check",
        title: "已添加新规则",
        description: `「${pattern}」已设置为 ${action}`,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      showToast({ variant: "error", title: "添加失败", description: msg })
    }
  }

  // 删除该工具的全部配置（恢复未配置状态）
  const removeToolConfig = (toolID: string) => {
    dialog.show(() => (
      <DialogConfirmAction
        title="移除配置"
        description={`确定要从本地配置文件中完全移除「${toolID}」的权限策略吗？`}
        confirmText="移除策略"
        danger={true}
        onConfirm={async () => {
          try {
            const current = { ...configuredPermission() }
            delete current[toolID]

            await serverSync().updateConfig({ permission: current as never })
            showToast({
              variant: "success",
              icon: "circle-check",
              title: "已移除配置",
              description: `工具「${toolID}」已从配置文件中移除。`,
            })
            backToPermissions()
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            showToast({ variant: "error", title: "移除失败", description: msg })
          }
        }}
        onClose={backToPermissions}
      />
    ))
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      {/* 顶部 Sticky 工具栏：与模型、代理页面 100% 对齐 */}
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-4 pt-6 pb-5 max-w-[800px]">
          <div class="flex items-center justify-between gap-4">
            <div class="flex items-baseline gap-2.5">
              <h2 class="text-16-medium text-text-strong">{language.t("settings.permissions.title")}</h2>
              <span class="text-12-regular text-text-subtle">本地配置的权限策略</span>
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
              <Button size="normal" variant="primary" icon="plus-small" onClick={() => openAddDialog()}>
                添加策略
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
              placeholder="搜索已配置工具、命令模式或规则..."
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

      {/* 主内容区域：与模型、代理页面设计语言 100% 一致 */}
      <div class="flex flex-col gap-6 max-w-[800px]">
        {/* 空状态提示 */}
        <Show when={configuredEntries().length === 0}>
          <div class="flex flex-col items-center justify-center py-12 px-4 rounded-xl border border-dashed border-border-weak-base text-center bg-surface-base/50">
            <Icon name="shield" class="size-8 text-icon-weak-base mb-3" />
            <span class="text-15-medium text-text-strong">
              {search() ? "未找到匹配的权限策略" : "配置文件中未声明任何权限策略"}
            </span>
            <p class="text-13-regular text-text-weak mt-1 mb-5 max-w-md">
              当前未在 opencode.json 中显式定义 permission 字段，所有工具均采用内置默认行为。
            </p>
            <Show when={!search()}>
              <Button variant="primary" icon="plus" onClick={() => openAddDialog()}>
                添加第一个权限策略
              </Button>
            </Show>
          </div>
        </Show>

        {/* 1. 多规则模式分组（如 bash 等含模式字典的工具）：与模型页面 Provider 列表 100% 同构 */}
        <For each={multiRuleEntries()}>
          {([toolID, val]) => {
            const meta = () => KNOWN_TOOLS[toolID]
            const rawMap = () => (val as Record<string, PermissionAction>) ?? {}
            const totalCount = () => Object.keys(rawMap()).length

            // 规则条目列表（保持原始键序）
            const rules = createMemo<Array<[string, PermissionAction]>>(() => {
              const entries = Object.entries(rawMap())
              const q = (ruleFilters()[toolID] ?? "").trim().toLowerCase()
              if (!q) return entries
              return entries.filter(([pattern, action]) => {
                return pattern.toLowerCase().includes(q) || action.toLowerCase().includes(q)
              })
            })

            const isAdding = () => showAddPatternFor()[toolID] ?? false

            return (
              <div class="flex flex-col gap-2">
                {/* 分组元信息栏：与模型页面 Provider 头部 100% 相同 */}
                <div class="flex items-center justify-between gap-3 px-1 pt-1">
                  <div class="flex items-center gap-2 min-w-0">
                    <Icon name={meta()?.icon ?? "terminal"} class="size-4 shrink-0 text-text-base" />
                    <span class="text-13-medium text-text-strong">
                      {meta()?.title ?? toolID}
                    </span>
                    <Show when={meta()}>
                      <span class="text-12-regular text-text-subtle font-mono">
                        ({toolID})
                      </span>
                    </Show>
                    <span class="text-12-regular text-text-subtle">·</span>
                    <span class="text-11-regular text-text-subtle">
                      {totalCount()} 条模式规则
                    </span>
                  </div>

                  {/* 右侧动作组 */}
                  <div class="flex items-center gap-1 shrink-0">
                    <Button
                      size="small"
                      variant="secondary"
                      icon="plus"
                      onClick={() => setShowAddPatternFor((prev) => ({ ...prev, [toolID]: !prev[toolID] }))}
                    >
                      {isAdding() ? "取消添加" : "添加规则"}
                    </Button>
                    <IconButton
                      icon="trash"
                      variant="ghost"
                      onClick={() => removeToolConfig(toolID)}
                      title="移除此工具全部规则"
                    />
                  </div>
                </div>

                {/* 展开的快捷添加规则输入栏 */}
                <Show when={isAdding()}>
                  <div class="flex items-center gap-2 p-2 bg-surface-base rounded-lg border border-border-weak-base/40">
                    <TextField
                      placeholder="输入匹配模式，如: git push*、rm *、docker 等"
                      value={newPatterns()[toolID] ?? ""}
                      onChange={(v) => setNewPatterns((prev) => ({ ...prev, [toolID]: v }))}
                      class="text-12-regular font-mono flex-1"
                    />
                    <div class="w-28 shrink-0">
                      <Select
                        options={ACTION_OPTIONS}
                        current={ACTION_OPTIONS.find((o) => o.value === (newActions()[toolID] ?? "ask"))}
                        value={(o) => o.value}
                        label={(o) => o.label}
                        onSelect={(opt) =>
                          opt && setNewActions((prev) => ({ ...prev, [toolID]: opt.value }))
                        }
                        variant="secondary"
                        size="small"
                        triggerStyle={{
                          height: "24px",
                          "min-width": "112px",
                          display: "inline-flex",
                          "align-items": "center",
                        }}
                        valueClass="text-12-regular"
                      />
                    </div>
                    <Button
                      size="small"
                      variant="primary"
                      icon="plus"
                      onClick={() => addPatternRule(toolID)}
                    >
                      确认添加
                    </Button>
                  </div>
                </Show>

                {/* 规则条目列表：统一采用原生 SettingsList 扁平渲染 */}
                <SettingsList>
                  {/* 若规则较多（> 8条），在列表顶置入轻量规则微过滤 */}
                  <Show when={totalCount() > 8}>
                    <div class="py-1.5 px-2 -mx-2 mb-1 border-b border-border-weak-base/20 flex items-center justify-between gap-2">
                      <span class="text-11-regular text-text-subtle">
                        自上而下匹配，最后命中的规则生效
                      </span>
                      <div class="w-40">
                        <TextField
                          type="text"
                          placeholder="筛选本工具规则..."
                          value={ruleFilters()[toolID] ?? ""}
                          onChange={(v) => setRuleFilters((prev) => ({ ...prev, [toolID]: v }))}
                          class="text-11-regular font-mono"
                        />
                      </div>
                    </div>
                  </Show>

                  <For each={rules()}>
                    {([pattern, action], index) => (
                      <div class="flex items-center justify-between gap-4 py-2 px-2 -mx-2 rounded-md border-b border-border-weak-base/20 last:border-none hover:bg-surface-base-hover/40 transition-colors group">
                        {/* 序号与模式名称 */}
                        <div class="flex items-center gap-2 min-w-0 flex-1">
                          <span class="text-11-medium font-mono text-text-subtle w-6 shrink-0 text-center select-none">
                            #{index() + 1}
                          </span>
                          <span
                            class={`font-mono text-12-medium truncate ${
                              pattern === "*" ? "text-text-strong font-bold" : "text-text-base"
                            }`}
                            title={pattern}
                          >
                            {pattern}
                          </span>
                          <Show when={pattern === "*"}>
                            <Tag class="text-10-regular font-sans bg-surface-raised-base text-text-subtle border border-border-weak-base/40 select-none">
                              兜底通配符
                            </Tag>
                          </Show>
                        </div>

                        {/* 右侧：操作按钮（Hover 渐入） + 动作单选药丸（完全同轴对齐） */}
                        <div class="flex items-center gap-2 shrink-0">
                          <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                            <IconButton
                              icon="trash"
                              variant="ghost"
                              onClick={() => deletePatternRule(toolID, pattern)}
                              title="删除此规则"
                            />
                          </div>

                          <div class="flex items-center rounded bg-surface-base p-0.5 border border-border-weak-base/40">
                            <For each={ACTION_OPTIONS}>
                              {(act) => {
                                const isActive = () => action === act.value
                                return (
                                  <button
                                    type="button"
                                    onClick={() => updatePatternRuleAction(toolID, pattern, act.value)}
                                    class={`px-2 py-0.5 text-11-medium rounded transition-all select-none ${
                                      isActive()
                                        ? act.value === "allow"
                                          ? "bg-surface-raised-base text-text-strong shadow-xs font-semibold"
                                          : act.value === "deny"
                                            ? "bg-surface-critical-base text-text-critical-base font-semibold"
                                            : "bg-surface-raised-base text-text-strong shadow-xs font-semibold"
                                        : "text-text-subtle hover:text-text-weak"
                                    }`}
                                  >
                                    {act.value}
                                  </button>
                                )
                              }}
                            </For>
                          </div>
                        </div>
                      </div>
                    )}
                  </For>
                </SettingsList>
              </div>
            )
          }}
        </For>

        {/* 2. 单一动作工具分组（如 external_directory 等）：与代理页面列表 100% 同构 */}
        <Show when={singleActionEntries().length > 0}>
          <div class="flex flex-col gap-2">
            <div class="flex items-center justify-between gap-3 px-1 pt-1">
              <div class="flex items-center gap-2 min-w-0">
                <Icon name="shield" class="size-4 shrink-0 text-text-base" />
                <span class="text-13-medium text-text-strong">基础工具策略</span>
                <span class="text-12-regular text-text-subtle">·</span>
                <span class="text-11-regular text-text-subtle">
                  {singleActionEntries().length} 项
                </span>
              </div>
            </div>

            <SettingsList>
              <For each={singleActionEntries()}>
                {([toolID, val]) => {
                  const meta = () => KNOWN_TOOLS[toolID]
                  const currentAction = () => (val as PermissionAction) ?? "ask"

                  return (
                    <div class="flex items-center justify-between gap-4 py-2 px-2 -mx-2 rounded-md border-b border-border-weak-base/20 last:border-none hover:bg-surface-base-hover/40 transition-colors group">
                      <div class="flex flex-col min-w-0 flex-1 pr-4">
                        <div class="flex items-center gap-2">
                          <span class="text-13-medium text-text-strong truncate">
                            {meta()?.title ?? toolID}
                          </span>
                          <Show when={meta()}>
                            <span class="text-11-regular text-text-subtle font-mono">
                              ({toolID})
                            </span>
                          </Show>
                        </div>
                        <Show when={meta()?.description}>
                          <span class="text-12-regular text-text-weak truncate max-w-sm sm:max-w-md pt-0.5">
                            {meta()?.description}
                          </span>
                        </Show>
                      </div>

                      <div class="flex items-center gap-1.5 shrink-0">
                        <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                          <IconButton
                            icon="edit"
                            variant="ghost"
                            onClick={() => openAddDialog(toolID)}
                            title="扩展为模式规则"
                          />
                          <IconButton
                            icon="trash"
                            variant="ghost"
                            onClick={() => removeToolConfig(toolID)}
                            title="移除此策略"
                          />
                        </div>

                        <Select
                          options={ACTION_OPTIONS}
                          current={ACTION_OPTIONS.find((o) => o.value === currentAction())}
                          value={(o) => o.value}
                          label={(o) => o.label}
                          onSelect={(opt) => opt && updateToolAction(toolID, opt.value)}
                          variant="secondary"
                          size="small"
                          triggerStyle={{
                            height: "24px",
                            "min-width": "112px",
                            display: "inline-flex",
                            "align-items": "center",
                          }}
                          valueClass="text-12-regular"
                        />
                      </div>
                    </div>
                  )
                }}
              </For>
            </SettingsList>
          </div>
        </Show>

        {/* 3. 快速添加其他常用工具（收敛在折叠下方，极简不喧宾夺主） */}
        <Show when={unconfiguredTools().length > 0}>
          <div class="flex flex-col gap-2 pt-2 border-t border-border-weak-base/20">
            <div class="flex items-center justify-between gap-3 px-1 pt-1">
              <span class="text-13-medium text-text-subtle">配置其他工具策略</span>
              <span class="text-11-regular text-text-subtle">
                {unconfiguredTools().length} 项未配置（当前为内置默认）
              </span>
            </div>

            <SettingsList>
              <For each={unconfiguredTools()}>
                {(tool) => (
                  <div class="flex items-center justify-between gap-4 py-2 px-2 -mx-2 rounded-md border-b border-border-weak-base/20 last:border-none hover:bg-surface-base-hover/40 transition-colors group">
                    <div class="flex flex-col min-w-0 flex-1 pr-4">
                      <div class="flex items-center gap-2">
                        <span class="text-13-medium text-text-weak">{tool.title}</span>
                        <span class="text-11-regular text-text-subtle font-mono">({tool.id})</span>
                      </div>
                      <span class="text-11-regular text-text-subtle truncate max-w-md pt-0.5">
                        {tool.description}
                      </span>
                    </div>

                    <div class="flex items-center gap-2 shrink-0">
                      <Button
                        size="small"
                        variant="secondary"
                        icon="plus"
                        onClick={() => updateToolAction(tool.id, tool.defaultAction)}
                      >
                        配置策略 ({tool.defaultAction})
                      </Button>
                    </div>
                  </div>
                )}
              </For>
            </SettingsList>
          </div>
        </Show>
      </div>
    </div>
  )
}
