import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Switch } from "@opencode-ai/ui/switch"
import { Tabs } from "@opencode-ai/ui/tabs"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useNavigate } from "@solidjs/router"
import { type Accessor, createEffect, createMemo, For, type JSXElement, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { ServerHealthIndicator, ServerRow } from "@/components/server/server-row"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { ServerConnection, useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { type ServerHealth } from "@/utils/server-health"
import { useGlobal } from "@/context/global"
import { useMcpToggle } from "@/context/mcp"
import { pluginFilePath, pluginLabel } from "./status-popover-indicator"

const pluginEmptyMessage = (value: string, file: string): JSXElement => {
  const parts = value.split(file)
  if (parts.length === 1) return value
  return (
    <>
      {parts[0]}
      <code class="bg-surface-raised-base px-1.5 py-0.5 rounded-sm text-text-base">{file}</code>
      {parts.slice(1).join(file)}
    </>
  )
}



const useDefaultServerKey = (
  get: (() => string | Promise<string | null | undefined> | null | undefined) | undefined,
) => {
  const [state, setState] = createStore({
    key: undefined as ServerConnection.Key | undefined,
    tick: 0,
  })

  createEffect(() => {
    state.tick
    let dead = false
    const result = get?.()
    if (!result) {
      setState("key", undefined)
      onCleanup(() => {
        dead = true
      })
      return
    }

    if (result instanceof Promise) {
      void result.then((next) => {
        if (dead) return
        setState("key", next ?? undefined)
      })
      onCleanup(() => {
        dead = true
      })
      return
    }

    setState("key", ServerConnection.Key.make(result))
    onCleanup(() => {
      dead = true
    })
  })

  return {
    key: () => {
      return state.key
    },
    refresh: () => setState("tick", (value) => value + 1),
  }
}

type ServerStatusState = {
  servers: () => ServerStatusItem[]
  defaultKey: () => ServerConnection.Key | undefined
  defaultLabel: string
  manageLabel: string
  onManage: () => void
}

type ServerStatusItem = {
  key: ServerConnection.Key
  conn: ServerConnection.Any
  health?: ServerHealth
  blocked: boolean
  active: boolean
  onSelect: () => void
}

// 与模型选择托盘保持同一视觉语言：同底色、同圆角描边、同浮层阴影。
const traySurface =
  "status-tray w-[360px] max-h-[420px] flex flex-col p-1.5 rounded-lg border border-border-base/50 bg-[var(--v2-background-bg-layer-01,var(--surface-raised-stronger-non-alpha))] shadow-[var(--v2-elevation-floating,var(--shadow-md))] overflow-hidden"
const trayRow =
  "flex items-center gap-2 w-full min-h-8 px-2 py-1.5 rounded-md text-left text-13-regular text-text-strong transition-colors"
const trayEmpty = "text-13-regular text-text-weak text-center px-2 py-4"

/** 服务器列表与“管理服务器”入口的状态，目录级与服务器级弹窗共用。 */
function useServerStatusState(): ServerStatusState {
  const global = useGlobal()
  const server = useServer()
  const platform = usePlatform()
  const dialog = useDialog()
  const language = useLanguage()
  const navigate = useNavigate()
  let dialogRun = 0
  let dialogDead = false
  onCleanup(() => {
    dialogDead = true
    dialogRun += 1
  })

  // 服务器列表保持注册顺序固定，不随健康探测结果或当前选中项重排，避免弹窗内条目跳动。
  const sortedServers = createMemo(() => global.servers.list())
  const defaultServer = useDefaultServerKey(platform.getDefaultServer)
  const serverItems = createMemo(() =>
    sortedServers().map((conn) => {
      const key = ServerConnection.key(conn)
      return {
        key,
        conn,
        health: global.servers.health[key],
        blocked: global.servers.health[key]?.healthy === false,
        active: !!server.current && key === ServerConnection.key(server.current),
        onSelect: () => {
          navigate("/")
          queueMicrotask(() => server.setActive(key))
        },
      }
    }),
  )

  return {
    servers: serverItems,
    defaultKey: defaultServer.key,
    defaultLabel: language.t("common.default"),
    manageLabel: language.t("status.popover.action.manageServers"),
    onManage: () => {
      const run = ++dialogRun
      void import("./dialog-select-server").then((x) => {
        if (dialogDead || dialogRun !== run) return
        dialog.show(() => <x.DialogSelectServer />, defaultServer.refresh)
      })
    },
  }
}

export function StatusPopoverServerBody() {
  const language = useLanguage()
  const state = useServerStatusState()

  return (
    <div class={traySurface}>
      <Tabs
        aria-label={language.t("status.popover.ariaLabel")}
        class="min-h-0"
        defaultValue="servers"
        variant="pill"
      >
        <TrayHeader state={state}>
          <TrayTab value="servers" count={state.servers().length} label={language.t("status.popover.tab.servers")} />
        </TrayHeader>
        <Tabs.Content value="servers">
          <ServerStatusList state={state} />
        </Tabs.Content>
      </Tabs>
    </div>
  )
}

/** 托盘顶部：左侧紧凑页签，右侧与模型托盘一致的图标操作。 */
function TrayHeader(props: { state: ServerStatusState; children: JSXElement }) {
  return (
    <div class="flex items-center gap-1 pb-1.5">
      <Tabs.List class="flex-1 min-w-0">{props.children}</Tabs.List>
      <Tooltip placement="top" value={props.state.manageLabel}>
        <IconButton
          icon="sliders"
          variant="ghost"
          iconSize="normal"
          class="size-6 shrink-0"
          aria-label={props.state.manageLabel}
          onClick={props.state.onManage}
        />
      </Tooltip>
    </div>
  )
}

function TrayTab(props: { value: string; count: number; label: string }) {
  return (
    <Tabs.Trigger value={props.value}>
      {props.label}
      <Show when={props.count > 0}>
        <span data-slot="status-tray-count">{props.count}</span>
      </Show>
    </Tabs.Trigger>
  )
}

function ServerStatusList(props: { state: ServerStatusState }) {
  return (
    <div class="flex flex-col gap-px">
      <For each={props.state.servers()}>
        {(item) => (
          <button
            type="button"
            class={trayRow}
            classList={{
              "hover:bg-surface-raised-base-hover": !item.blocked,
              "cursor-not-allowed": item.blocked,
            }}
            aria-disabled={item.blocked}
            onClick={() => {
              if (item.blocked) return
              item.onSelect()
            }}
          >
            <ServerHealthIndicator health={item.health} />
            <ServerRow
              conn={item.conn}
              dimmed={item.blocked}
              status={item.health}
              class="flex items-center gap-2 w-full min-w-0"
              nameClass="text-13-regular text-text-strong truncate"
              versionClass="text-12-regular text-text-weak truncate"
              badge={
                <Show when={item.key === props.state.defaultKey()}>
                  <span class="text-11-regular text-text-base bg-surface-base px-1.5 py-0.5 rounded-md">
                    {props.state.defaultLabel}
                  </span>
                </Show>
              }
            >
              <div class="flex-1" />
              <Show when={item.active}>
                <Icon name="check" size="small" class="text-icon-weak shrink-0" />
              </Show>
            </ServerRow>
          </button>
        )}
      </For>
    </div>
  )
}

export function StatusPopoverBody(props: { shown: Accessor<boolean> }) {
  const sync = useSync()
  const global = useGlobal()
  const platform = usePlatform()
  const language = useLanguage()
  const state = useServerStatusState()

  createEffect(() => {
    if (!props.shown()) return
  })

  const toggleMcp = useMcpToggle()
  const mcpNames = createMemo(() => Object.keys(sync().data.mcp ?? {}).sort((a, b) => a.localeCompare(b)))
  const mcpStatus = (name: string) => sync().data.mcp?.[name]?.status
  const mcpConnected = createMemo(() => mcpNames().filter((name) => mcpStatus(name) === "connected").length)
  const plugins = createMemo(() =>
    (sync().data.config.plugin ?? []).map((item) => (typeof item === "string" ? item : item[0])),
  )
  const pluginEmpty = createMemo(() => pluginEmptyMessage(language.t("dialog.plugins.empty"), "opencode.json"))

  return (
    <div class={traySurface}>
      <Tabs
        aria-label={language.t("status.popover.ariaLabel")}
        class="min-h-0"
        defaultValue="servers"
        variant="pill"
      >
        <TrayHeader state={state}>
          <TrayTab
            value="servers"
            count={global.servers.list().length}
            label={language.t("status.popover.tab.servers")}
          />
          <TrayTab value="mcp" count={mcpConnected()} label={language.t("status.popover.tab.mcp")} />
          <TrayTab value="plugins" count={plugins().length} label={language.t("status.popover.tab.plugins")} />
        </TrayHeader>

        <Tabs.Content value="servers">
          <ServerStatusList state={state} />
        </Tabs.Content>

        <Tabs.Content value="mcp">
          <Show when={mcpNames().length > 0} fallback={<div class={trayEmpty}>{language.t("dialog.mcp.empty")}</div>}>
            <div class="flex flex-col gap-px">
              <For each={mcpNames()}>
                {(name) => {
                  const status = () => mcpStatus(name)
                  const enabled = () => status() === "connected"
                  return (
                    <button
                      type="button"
                      class={`${trayRow} hover:bg-surface-raised-base-hover`}
                      onClick={() => {
                        if (toggleMcp.isPending) return
                        toggleMcp.mutate(name)
                      }}
                      disabled={toggleMcp.isPending && toggleMcp.variables === name}
                    >
                      <div
                        classList={{
                          "size-1.5 rounded-full shrink-0": true,
                          "bg-icon-success-base": status() === "connected",
                          "bg-icon-critical-base": status() === "failed",
                          "bg-border-weak-base": status() === "disabled",
                          "bg-icon-warning-base": status() === "needs_auth" || status() === "needs_client_registration",
                        }}
                      />
                      <span class="flex flex-col min-w-0 flex-1">
                        <span class="truncate">{name}</span>
                        <Show when={status() === "needs_auth"}>
                          <span class="text-11-regular text-text-weaker truncate">
                            {language.t("mcp.auth.clickToAuthenticate")}
                          </span>
                        </Show>
                      </span>
                      <div onClick={(event) => event.stopPropagation()}>
                        <Switch
                          checked={enabled()}
                          disabled={toggleMcp.isPending && toggleMcp.variables === name}
                          onChange={() => {
                            if (toggleMcp.isPending) return
                            toggleMcp.mutate(name)
                          }}
                        />
                      </div>
                    </button>
                  )
                }}
              </For>
            </div>
          </Show>
        </Tabs.Content>

        <Tabs.Content value="plugins">
          <Show when={plugins().length > 0} fallback={<div class={trayEmpty}>{pluginEmpty()}</div>}>
            <div class="flex flex-col gap-px">
              <For each={plugins()}>
                {(plugin) => {
                  const path = pluginFilePath(plugin)
                  const openable = !!path && !!platform.revealPath
                  return (
                    <button
                      type="button"
                      class={trayRow}
                      classList={{
                        "hover:bg-surface-raised-base-hover cursor-pointer": openable,
                        "cursor-default": !openable,
                      }}
                      title={path ?? plugin}
                      onClick={() => {
                        if (!path || !platform.revealPath) return
                        void platform.revealPath(path)
                      }}
                    >
                      <div class="size-1.5 rounded-full shrink-0 bg-icon-success-base" />
                      <span class="truncate">{pluginLabel(plugin)}</span>
                    </button>
                  )
                }}
              </For>
            </div>
          </Show>
        </Tabs.Content>
      </Tabs>
    </div>
  )
}
