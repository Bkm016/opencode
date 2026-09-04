import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Switch } from "@opencode-ai/ui/switch"
import { TextField } from "@opencode-ai/ui/text-field"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createMemo, createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import type { Config, McpLocalConfig, McpRemoteConfig } from "@opencode-ai/sdk/v2"

export type McpServerConfig = McpLocalConfig | McpRemoteConfig

export interface McpFormProps {
  name?: string
  initial?: {
    name?: string
    type?: "local" | "remote"
    command?: string[]
    url?: string
    cwd?: string
    environment?: Record<string, string>
    headers?: Record<string, string>
    timeout?: number
    enabled?: boolean
  }
  onBack?: () => void
  onClose?: () => void
}

/**
 * 将命令行字符串安全拆分为参数列表（支持单/双引号包裹）
 */
function parseCommandLine(cmdStr: string): string[] {
  const trimmed = cmdStr.trim()
  if (!trimmed) return []
  const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g
  const args: string[] = []
  let match: RegExpExecArray | null
  while ((match = regex.exec(trimmed)) !== null) {
    if (match[1] !== undefined) {
      args.push(match[1])
    } else if (match[2] !== undefined) {
      args.push(match[2])
    } else {
      args.push(match[0])
    }
  }
  return args
}

/**
 * 格式化命令参数为便于单行编辑的字符串
 */
function formatCommandLine(cmd?: string[]): string {
  if (!cmd || cmd.length === 0) return ""
  return cmd
    .map((arg) => {
      if (arg.includes(" ") || arg.includes('"') || arg.includes("'")) {
        return `"${arg.replace(/"/g, '\\"')}"`
      }
      return arg
    })
    .join(" ")
}

/**
 * 解析多行 KEY=VALUE 环境变量
 */
function parseEnvText(text: string): Record<string, string> | undefined {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length === 0) return undefined
  const env: Record<string, string> = {}
  for (const line of lines) {
    const eqIdx = line.indexOf("=")
    if (eqIdx > 0) {
      const k = line.slice(0, eqIdx).trim()
      const v = line.slice(eqIdx + 1).trim()
      if (k) env[k] = v
    }
  }
  return Object.keys(env).length > 0 ? env : undefined
}

function formatEnvText(env?: Record<string, string>): string {
  if (!env) return ""
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")
}

/**
 * 解析多行 Header-Name: Value 请求头
 */
function parseHeadersText(text: string): Record<string, string> | undefined {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length === 0) return undefined
  const headers: Record<string, string> = {}
  for (const line of lines) {
    const colonIdx = line.indexOf(":")
    if (colonIdx > 0) {
      const k = line.slice(0, colonIdx).trim()
      const v = line.slice(colonIdx + 1).trim()
      if (k) headers[k] = v
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}

function formatHeadersText(headers?: Record<string, string>): string {
  if (!headers) return ""
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")
}

/**
 * 添加 / 编辑 MCP 配置对话框 (与 DialogAgentConfig、DialogModelConfig 100% 对齐)
 */
export function DialogMcpConfig(props: McpFormProps) {
  const dialog = useDialog()
  const language = useLanguage()
  const serverSync = useServerSync()
  const isEditing = !!props.name

  const [form, setForm] = createStore({
    name: props.name ?? "",
    type: (props.initial?.type ?? "local") as "local" | "remote",
    command: formatCommandLine(props.initial?.command),
    url: props.initial?.url ?? "",
    cwd: props.initial?.cwd ?? "",
    environment: formatEnvText(props.initial?.environment),
    headers: formatHeadersText(props.initial?.headers),
    timeout: props.initial?.timeout ? String(props.initial.timeout) : "",
    enabled: props.initial?.enabled !== false,
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

  // 实时预览解析后的命令行参数数组
  const parsedCommandPreview = createMemo(() => {
    if (form.type !== "local") return []
    return parseCommandLine(form.command)
  })

  const save = async (e: SubmitEvent) => {
    e.preventDefault()
    if (busy()) return

    const name = form.name.trim()
    if (!name) {
      setError("MCP 服务名称不能为空")
      return
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      setError("服务名称仅支持字母、数字、下划线与连字符（如 github、postgres、my_server）")
      return
    }

    if (form.type === "local") {
      const args = parseCommandLine(form.command)
      if (args.length === 0) {
        setError("本地进程模式必须指定启动命令（Command）")
        return
      }
    } else {
      const url = form.url.trim()
      if (!url) {
        setError("远程服务模式必须指定服务器 URL 地址")
        return
      }
      try {
        new URL(url)
      } catch {
        setError("请输入有效的远程 URL（如 https://example.com/sse 或 http://127.0.0.1:8000/sse）")
        return
      }
    }

    setBusy(true)
    setError(undefined)

    try {
      const currentConfig = serverSync().data.config
      const currentMcpMap: NonNullable<Config["mcp"]> = { ...(currentConfig.mcp ?? {}) }

      // 如果是重命名，先清理旧键
      if (isEditing && props.name && props.name !== name) {
        delete currentMcpMap[props.name]
      }

      const timeoutNum = form.timeout.trim() ? parseInt(form.timeout.trim(), 10) : undefined

      if (form.type === "local") {
        const localCfg: McpLocalConfig = {
          type: "local",
          command: parseCommandLine(form.command),
          enabled: form.enabled,
        }
        if (form.cwd.trim()) {
          localCfg.cwd = form.cwd.trim()
        }
        const envObj = parseEnvText(form.environment)
        if (envObj) {
          localCfg.environment = envObj
        }
        if (timeoutNum && !isNaN(timeoutNum)) {
          localCfg.timeout = timeoutNum
        }
        currentMcpMap[name] = localCfg
      } else {
        const remoteCfg: McpRemoteConfig = {
          type: "remote",
          url: form.url.trim(),
          enabled: form.enabled,
        }
        const headersObj = parseHeadersText(form.headers)
        if (headersObj) {
          remoteCfg.headers = headersObj
        }
        if (timeoutNum && !isNaN(timeoutNum)) {
          remoteCfg.timeout = timeoutNum
        }
        currentMcpMap[name] = remoteCfg
      }

      await serverSync().updateConfig({ mcp: currentMcpMap })

      showToast({
        variant: "success",
        icon: "circle-check",
        title: isEditing ? "MCP 服务器已更新" : "MCP 服务器已添加",
        description: `服务器「${name}」配置已保存并立即生效。`,
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
          <span class="text-16-medium text-text-strong">{isEditing ? `编辑 MCP: ${form.name}` : "添加 MCP"}</span>
        </div>
      }
      size="large"
      class="h-full flex flex-col min-h-0 overflow-hidden"
      transition
    >
      <form onSubmit={save} class="flex flex-col flex-1 min-h-0 overflow-hidden w-full">
        <div class="flex-1 overflow-y-auto no-scrollbar px-6 sm:px-8 py-5 flex flex-col gap-6 w-full">
          {/* 错误提示横幅 */}
          <Show when={error()}>
            <div class="p-3 text-13-regular rounded-lg bg-surface-critical-base text-text-critical-base">{error()}</div>
          </Show>

          <div class="flex flex-col gap-5">
            {/* 服务标识 */}
            <TextField
              label="服务标识 / 名称"
              placeholder="例如: github, postgres, everything"
              value={form.name}
              disabled={isEditing}
              onChange={(v) => setForm("name", v)}
              description={isEditing ? "服务标识无法修改" : "唯一名称标识，由智能体在调用 MCP 工具时作为命名空间前缀"}
              required
            />

            {/* 服务类型 (模式选择按钮组，与 Mode 模式选择完全一致) */}
            <div class="flex flex-col gap-1.5">
              <label class="text-12-medium text-text-weak">服务类型 (Type)</label>
              <div class="grid grid-cols-2 gap-2">
                <For
                  each={[
                    { label: "本地进程 (local)", value: "local" as const },
                    { label: "远程服务 (remote)", value: "remote" as const },
                  ]}
                >
                  {(item) => {
                    const active = () => form.type === item.value
                    return (
                      <button
                        type="button"
                        class="px-3 py-2 text-12-medium rounded-md border transition-colors text-center"
                        classList={{
                          "bg-primary-base text-text-inverse-base border-transparent": active(),
                          "bg-surface-weak-base text-text-strong border-border-weak-base hover:bg-surface-base":
                            !active(),
                        }}
                        onClick={() => setForm("type", item.value)}
                      >
                        {item.label}
                      </button>
                    )
                  }}
                </For>
              </div>
              <span class="text-12-regular text-text-weak">
                {form.type === "local"
                  ? "通过本地命令行（stdio）启动并双向通信的 MCP 独立子进程"
                  : "通过 HTTP / Server-Sent Events (SSE) 长连接访问的远程 MCP 外部服务"}
              </span>
            </div>

            {/* 本地进程模式特有字段 */}
            <Show when={form.type === "local"}>
              <div class="flex flex-col gap-5">
                <div class="flex flex-col gap-1.5">
                  <TextField
                    label="启动命令 (Command)"
                    placeholder="例如: npx -y @modelcontextprotocol/server-everything"
                    value={form.command}
                    onChange={(v) => setForm("command", v)}
                    description="完整的启动命令与参数（支持空格与引号包裹）"
                    required
                  />
                  <Show when={parsedCommandPreview().length > 0}>
                    <div class="flex flex-wrap items-center gap-1.5 pt-1">
                      <span class="text-11-regular text-text-subtle shrink-0">参数拆解:</span>
                      <For each={parsedCommandPreview()}>
                        {(arg) => (
                          <span class="px-1.5 py-0.5 rounded text-11-medium font-mono bg-surface-weak-base text-text-strong border border-border-weak-base">
                            {arg}
                          </span>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>

                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <TextField
                    label="工作目录 (CWD，可选)"
                    placeholder="例如: ./ 或 /path/to/cwd"
                    value={form.cwd}
                    onChange={(v) => setForm("cwd", v)}
                    description="进程启动时使用的工作目录（相对路径相对于工作区）"
                  />
                  <TextField
                    label="请求超时 (Timeout，可选)"
                    placeholder="默认 5000 毫秒"
                    value={form.timeout}
                    onChange={(v) => setForm("timeout", v)}
                    description="MCP 单次交互与工具调用的超时毫秒数"
                  />
                </div>

                <div class="flex flex-col gap-1.5">
                  <label class="text-12-medium text-text-weak">环境变量 (Environment，可选)</label>
                  <textarea
                    class="w-full h-24 px-3 py-2 text-13-regular font-mono rounded-lg bg-surface-base border border-border-weak-base text-text-strong focus:border-border-base focus:outline-none resize-y placeholder:text-text-weaker"
                    placeholder="每行一个 KEY=VALUE，例如:&#10;GITHUB_TOKEN=ghp_xxxx&#10;DEBUG=true"
                    value={form.environment}
                    onInput={(e) => setForm("environment", e.currentTarget.value)}
                    disabled={busy()}
                  />
                  <span class="text-12-regular text-text-weak">
                    每行一条 KEY=VALUE，启动本地进程时将注入这些环境变量
                  </span>
                </div>
              </div>
            </Show>

            {/* 远程服务模式特有字段 */}
            <Show when={form.type === "remote"}>
              <div class="flex flex-col gap-5">
                <TextField
                  label="服务器 URL"
                  placeholder="https://example.com/sse 或 http://127.0.0.1:8000/sse"
                  value={form.url}
                  onChange={(v) => setForm("url", v)}
                  description="支持 HTTP / SSE 协议的远程 MCP 服务连接地址"
                  required
                />

                <TextField
                  label="请求超时 (Timeout，可选)"
                  placeholder="默认 5000 毫秒"
                  value={form.timeout}
                  onChange={(v) => setForm("timeout", v)}
                  description="MCP 远程连接与工具调用的超时毫秒数"
                />

                <div class="flex flex-col gap-1.5">
                  <label class="text-12-medium text-text-weak">自定义请求头 (Headers，可选)</label>
                  <textarea
                    class="w-full h-24 px-3 py-2 text-13-regular font-mono rounded-lg bg-surface-base border border-border-weak-base text-text-strong focus:border-border-base focus:outline-none resize-y placeholder:text-text-weaker"
                    placeholder="每行一个 Header-Name: Value，例如:&#10;Authorization: Bearer sk-xxxx&#10;X-Custom-Header: value"
                    value={form.headers}
                    onInput={(e) => setForm("headers", e.currentTarget.value)}
                    disabled={busy()}
                  />
                  <span class="text-12-regular text-text-weak">
                    每行一条 Header-Name: Value，向远程 MCP 发起连接时将自动附加这些请求头
                  </span>
                </div>
              </div>
            </Show>

            {/* 开关配置组 (与 Agent 页面底部的 Switch 结构 100% 对齐) */}
            <div class="flex flex-col border-t border-border-weak-base pt-2">
              <div class="flex items-center justify-between py-2.5">
                <div class="flex flex-col">
                  <span class="text-14-medium text-text-strong">启用此 MCP 服务器</span>
                  <span class="text-12-regular text-text-weak">启动时自动连通并注册该服务器提供的工具与资源</span>
                </div>
                <Switch checked={form.enabled} onChange={(checked) => setForm("enabled", checked)} hideLabel>
                  启用此 MCP 服务器
                </Switch>
              </div>
            </div>
          </div>
        </div>

        {/* 底部固定吸底操作按钮栏 (与 DialogAgentConfig 100% 像素级对齐) */}
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
