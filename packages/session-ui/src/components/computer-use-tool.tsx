import type { ToolPart } from "@opencode-ai/sdk/v2"
import { createMemo, createSignal, For, Index, Match, Show, Switch } from "solid-js"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { ImagePreview } from "@opencode-ai/ui/image-preview"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { BasicTool } from "./basic-tool"
import type { ToolProps } from "./message-part"
import type { GroupToolRefs } from "./message-part-groups"
import { AnimatedCountList } from "./tool-count-summary"
import { ToolStatusTitle } from "./tool-status-title"

/** list_windows 返回的窗口条目；app 可能是完整进程路径，由 basename 展示。 */
type WindowRecord = { app?: unknown; id?: unknown; title?: unknown; detail?: string }

/** get_window_state 返回的窗口状态，与官方 helper window2.WindowState 对齐；字段宽松到 unknown 以便逐段校验。 */
type WindowState = {
  window?: { app?: unknown; id?: unknown; title?: unknown }
  accessibility?: {
    tree?: unknown
    focused_element?: unknown
    selected_text?: unknown
    selected_elements?: unknown
    document_text?: unknown
  } | null
}

const FALLBACK_LIMIT = 8000

const ACTION_KEYS = {
  list_windows: "ui.tool.computerUse.action.listWindows",
  list_apps: "ui.tool.computerUse.action.listApps",
  set_value: "ui.tool.computerUse.action.setValue",
  perform_secondary_action: "ui.tool.computerUse.action.secondaryAction",
  activate_window: "ui.tool.computerUse.action.activateWindow",
  get_window: "ui.tool.computerUse.action.getWindow",
  get_window_state: "ui.tool.computerUse.action.getWindowState",
  click: "ui.tool.computerUse.action.click",
  type_text: "ui.tool.computerUse.action.typeText",
  press_key: "ui.tool.computerUse.action.pressKey",
  scroll: "ui.tool.computerUse.action.scroll",
  drag: "ui.tool.computerUse.action.drag",
  launch_app: "ui.tool.computerUse.action.launchApp",
} as const

/** 动作对应的 i18n 键；未知动作返回 undefined，由调用方回退。 */
function actionKey(action: unknown) {
  if (typeof action !== "string") return undefined
  return ACTION_KEYS[action as keyof typeof ACTION_KEYS]
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined
}

/** 展示用应用名取路径 basename；完整路径仅在窗口记录的 title 属性里保留。 */
function basename(app: string) {
  const trimmed = app.trim()
  if (!/[\\/]/.test(trimmed)) return trimmed
  return trimmed.split(/[\\/]/).filter(Boolean).pop() ?? trimmed
}

/** 解析结构化输出；未通过工具输出长度限制的截断 JSON 在此解析失败，由调用方走有界纯文本兜底。 */
function parse(output: string | undefined) {
  if (!output) return undefined
  try {
    return JSON.parse(output) as unknown
  } catch {
    return undefined
  }
}

function windowsOf(result: unknown): WindowRecord[] {
  if (!Array.isArray(result)) return []
  return result.filter((entry): entry is WindowRecord => record(entry))
}

/** 结构化结果是否为空壳（null/空对象/空数组），此类结果视为无正文，不值得展开 */
function hollow(result: unknown) {
  if (result === null || result === undefined) return true
  if (Array.isArray(result)) return result.length === 0
  if (record(result)) return Object.keys(result).length === 0
  return false
}

/** 头部副标题：动作本地化短语 + 窗口应用 basename，直接空格相连不加分隔符；完整路径只放 title 提示，避免长路径撑爆布局。 */
function triggerSubtitle(i18n: ReturnType<typeof useI18n>, input: Record<string, unknown>, metadata: Record<string, unknown>) {
  const key = actionKey(input.action)
  const action = key ? i18n.t(key) : text(input.action) ?? i18n.t("ui.tool.computerUse")
  const window = record(input.window) ? input.window : undefined
  const app = text(window?.app) ?? text(metadata.app)
  if (!app) return action
  return `${action} ${basename(app)}`
}

/** 本机电脑操作保留动作、错误和截图，便于用户核对实际执行结果；传入 part 时直接读取其状态供分组行使用。 */
export function ComputerUseTool(props: ToolProps & { part?: ToolPart }) {
  const i18n = useI18n()
  const dialog = useDialog()
  const pending = () => props.status === "pending" || props.status === "running"
  const subtitle = createMemo(() => triggerSubtitle(i18n, props.input, props.metadata))
  const images = createMemo(() => (props.attachments ?? []).filter((file) => file.mime.startsWith("image/")))
  const action = () => props.input.action
  const result = createMemo(() => parse(props.output))
  const windows = createMemo(() => {
    if (action() === "list_windows") return windowsOf(result())
    if (action() === "get_window") return windowsOf([result()])
    const apps = result()
    if (action() === "list_apps" && Array.isArray(apps)) {
      // 应用目录沿用紧凑列表，只显示名称、标识和运行信息，不展开原始窗口数组。
      return apps.filter(record).map((app): WindowRecord => ({
        app: app.id,
        title: text(app.displayName) ?? (text(app.id) ? basename(String(app.id)) : undefined),
        detail: [
          typeof app.isRunning === "boolean"
            ? i18n.t(app.isRunning ? "ui.tool.computerUse.runningApp" : "ui.tool.computerUse.stoppedApp")
            : undefined,
          Array.isArray(app.windows)
            ? i18n.t("ui.tool.computerUse.windowCount", { count: app.windows.length })
            : undefined,
        ].filter(Boolean).join(" · "),
      }))
    }
    return []
  })
  const state = createMemo(() => (action() === "get_window_state" && record(result()) ? (result() as WindowState) : undefined))
  // 截断或非 JSON 输出走有界纯文本兜底；空壳结果（{}、null）视为无正文，不展示
  const body = createMemo(() => {
    const output = props.output
    if (!output) return undefined
    if (result() === undefined) return output.length > FALLBACK_LIMIT ? `${output.slice(0, FALLBACK_LIMIT)}…` : output
    if (hollow(result()) || windows().length > 0 || state()) return undefined
    return output
  })
  // 展开卡片仅在确有正文（输出文本、窗口列表、状态、截图或错误）时渲染，否则不展开
  const empty = createMemo(
    () =>
      props.status !== "error" &&
      !body() &&
      windows().length === 0 &&
      !state() &&
      images().length === 0,
  )

  return (
    <BasicTool
      {...props}
      icon="window-cursor"
      allowPendingDetails
      hideDetails={empty()}
      forceOpen={pending() || props.status === "error"}
      trigger={{
        title: i18n.t("ui.tool.computerUse"),
        subtitle: subtitle(),
        // 副标题自带动作与目标，去掉工具名后默认的间隔点
        subtitleClass: "computer-use-subtitle",
      }}
    >
      <Show when={!empty()}>
        <div data-component="computer-use-tool-output">
          <Show when={props.status === "error" && props.error}>
            <div role="alert">{props.error}</div>
          </Show>
          <Show when={windows().length > 0}>
            <ScrollView data-slot="computer-use-windows-scroll">
              <ul data-slot="computer-use-windows">
                <For each={windows()}>
                  {(entry) => {
                    const app = text(entry.app)
                    return (
                      <li data-slot="computer-use-window">
                        <span data-slot="computer-use-window-title">
                          {text(entry.title) ?? i18n.t("ui.tool.computerUse.untitled")}
                        </span>
                        <Show when={app}>
                          {(value) => (
                            <span data-slot="computer-use-window-app" title={value()}>
                              {basename(value())}
                            </span>
                          )}
                        </Show>
                        <Show when={typeof entry.id === "number"}>
                          <span data-slot="computer-use-window-id">#{String(entry.id)}</span>
                        </Show>
                        <Show when={entry.detail}>
                          <span data-slot="computer-use-window-app" title={entry.detail}>{entry.detail}</span>
                        </Show>
                      </li>
                    )
                  }}
                </For>
              </ul>
            </ScrollView>
          </Show>
          <Show when={state()}>{(value) => <WindowStateView state={value()} />}</Show>
          <Show when={body()}>
            <ScrollView data-slot="computer-use-fallback-scroll">
              <pre>{body()}</pre>
            </ScrollView>
          </Show>
          <For each={images()}>
            {(file) => (
              <button
                type="button"
                data-slot="computer-use-screenshot"
                onClick={() =>
                  dialog.show(() => <ImagePreview src={file.url} alt={file.filename ?? i18n.t("ui.imagePreview.alt")} />)
                }
              >
                <img src={file.url} alt={file.filename ?? i18n.t("ui.imagePreview.alt")} loading="lazy" />
              </button>
            )}
          </For>
        </div>
      </Show>
    </BasicTool>
  )
}

/** get_window_state 的结构化视图：无障碍树按解码后的真实多行文本渲染，不再显示转义 "\n"。 */
function WindowStateView(props: { state: WindowState }) {
  const i18n = useI18n()
  const window = createMemo(() => (record(props.state.window) ? props.state.window : undefined))
  const accessibility = createMemo(() => (record(props.state.accessibility) ? props.state.accessibility : undefined))
  const title = createMemo(() => text(window()?.title) ?? i18n.t("ui.tool.computerUse.untitled"))
  const app = createMemo(() => text(window()?.app))
  const tree = createMemo(() => text(accessibility()?.tree))
  const focused = createMemo(() => text(accessibility()?.focused_element))
  const selected = createMemo(() => {
    const value = accessibility()?.selected_elements
    if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string" && !!entry.trim())
    const single = text(accessibility()?.selected_text)
    return single ? [single] : []
  })
  const document = createMemo(() => text(accessibility()?.document_text))

  return (
    <>
      <div data-slot="computer-use-window-summary">
        <span data-slot="computer-use-window-title">{title()}</span>
        <Show when={app()}>
          {(value) => (
            <span data-slot="computer-use-window-app" title={value()}>
              {basename(value())}
            </span>
          )}
        </Show>
        <Show when={typeof window()?.id === "number"}>
          <span data-slot="computer-use-window-id">#{String(window()!.id)}</span>
        </Show>
      </div>
      <Show when={tree()}>
        <ScrollView data-slot="computer-use-tree-scroll">
          <pre data-slot="computer-use-tree">{tree()}</pre>
        </ScrollView>
      </Show>
      <Show when={focused()}>
        <div data-slot="computer-use-focused">
          <span data-slot="computer-use-label">{i18n.t("ui.tool.computerUse.focused")}</span>
          <span data-slot="computer-use-value">{focused()}</span>
        </div>
      </Show>
      <Show when={selected().length > 0}>
        <div data-slot="computer-use-selected">
          <span data-slot="computer-use-label">{i18n.t("ui.tool.computerUse.selectedText")}</span>
          <For each={selected()}>{(entry) => <span data-slot="computer-use-value">{entry}</span>}</For>
        </div>
      </Show>
      <Show when={document()}>
        <div data-slot="computer-use-document">
          <span data-slot="computer-use-label">{i18n.t("ui.tool.computerUse.documentText")}</span>
          <ScrollView data-slot="computer-use-document-scroll">
            <pre>{document()}</pre>
          </ScrollView>
        </div>
      </Show>
    </>
  )
}

/** 连续 computer_use 调用的折叠组；头部汇总观察/操作/失败次数，展开后各行仍可单独展开查看完整详情。 */
export function ComputerUseToolGroup(props: { parts: ToolPart[] } & GroupToolRefs) {
  const i18n = useI18n()
  const [localOpen, setLocalOpen] = createSignal(false)
  const open = () => props.open ?? localOpen()
  const pending = createMemo(
    () =>
      !!props.busy || props.parts.some((part) => part.state.status === "pending" || part.state.status === "running"),
  )
  const summary = createMemo(() => {
    const counts = { observe: 0, action: 0, error: 0 }
    for (const part of props.parts) {
      if (part.state.status === "error") counts.error++
      const action = (part.state.input as Record<string, unknown> | undefined)?.action
      if (action === "list_windows" || action === "list_apps" || action === "get_window_state" || action === "get_window") counts.observe++
      else counts.action++
    }
    return counts
  })
  const handleOpenChange = (value: boolean) => {
    if (props.open === undefined) setLocalOpen(value)
    props.onOpenChange?.(value)
    props.onSizeChange?.()
  }

  return (
    <Collapsible
      open={open()}
      onOpenChange={handleOpenChange}
      variant="ghost"
      class="tool-collapsible"
      data-timeline-part-ids={props.parts.map((part) => part.id).join(",")}
    >
      <Collapsible.Trigger>
        <div data-component="computer-use-group-trigger">
          <span
            data-slot="computer-use-group-title"
            class="min-w-0 flex items-center gap-2 text-14-medium text-text-strong"
          >
            <span data-slot="computer-use-group-label" class="shrink-0">
              <ToolStatusTitle
                active={pending()}
                activeText={i18n.t("ui.sessionTurn.status.usingComputer")}
                doneText={i18n.t("ui.sessionTurn.status.usedComputer")}
                split={false}
              />
            </span>
            <span
              data-slot="computer-use-group-summary"
              class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-normal text-text-base"
            >
              <AnimatedCountList
                items={[
                  {
                    key: "observe",
                    count: summary().observe,
                    one: i18n.t("ui.messagePart.computerUse.observe.one"),
                    other: i18n.t("ui.messagePart.computerUse.observe.other"),
                  },
                  {
                    key: "action",
                    count: summary().action,
                    one: i18n.t("ui.messagePart.computerUse.action.one"),
                    other: i18n.t("ui.messagePart.computerUse.action.other"),
                  },
                  {
                    key: "error",
                    count: summary().error,
                    one: i18n.t("ui.messagePart.computerUse.error.one"),
                    other: i18n.t("ui.messagePart.computerUse.error.other"),
                  },
                ]}
                fallback=""
              />
            </span>
          </span>
          <Collapsible.Arrow />
        </div>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <div data-component="computer-use-group-list">
          <Index each={props.parts}>
            {(partAccessor) => {
              const input = createMemo(() => partAccessor().state.input ?? {})
              const metadata = createMemo(
                () =>
                  // @ts-expect-error metadata 仅存在于 running/completed 状态
                  partAccessor().state.metadata ?? {},
              )
              const output = createMemo(() =>
                partAccessor().state.status === "completed" ? partAccessor().state.output : undefined,
              )
              const error = createMemo(() =>
                partAccessor().state.status === "error" ? partAccessor().state.error : undefined,
              )
              const attachments = createMemo(() =>
                partAccessor().state.status === "completed" ? partAccessor().state.attachments : undefined,
              )
              return (
                <div data-slot="computer-use-group-item">
                  <ComputerUseTool
                    part={partAccessor()}
                    tool="computer_use"
                    input={input()}
                    metadata={metadata()}
                    output={output()}
                    status={partAccessor().state.status}
                    error={error()}
                    attachments={attachments()}
                    sessionID={partAccessor().sessionID}
                    partID={partAccessor().id}
                  />
                </div>
              )
            }}
          </Index>
        </div>
      </Collapsible.Content>
    </Collapsible>
  )
}
