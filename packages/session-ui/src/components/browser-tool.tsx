import { createMemo, For, Show } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { ImagePreview } from "@opencode-ai/ui/image-preview"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { BasicTool } from "./basic-tool"
import type { ToolProps } from "./message-part"

const ACTION_KEYS = {
  navigate: "ui.tool.browser.action.navigate",
  screenshot: "ui.tool.browser.action.screenshot",
  get_content: "ui.tool.browser.action.getContent",
  click: "ui.tool.browser.action.click",
  type_text: "ui.tool.browser.action.typeText",
  press_key: "ui.tool.browser.action.pressKey",
  scroll: "ui.tool.browser.action.scroll",
  evaluate: "ui.tool.browser.action.evaluate",
  back: "ui.tool.browser.action.back",
  close: "ui.tool.browser.action.close",
} as const

const CONTENT_LIMIT = 4000

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined
}

/** 动作对应的 i18n 键；未知动作返回 undefined，由调用方回退为原始字符串。 */
function actionKey(action: unknown) {
  if (typeof action !== "string") return undefined
  return ACTION_KEYS[action as keyof typeof ACTION_KEYS]
}

/** URL 缩略成 origin + pathname（去尾斜杠），查询串省略；完整地址由调用方放 title 悬浮提示。 */
function shortUrl(raw: string) {
  try {
    const url = new URL(raw)
    const path = url.pathname === "/" ? "" : url.pathname
    return `${url.origin}${path}` || url.origin
  } catch {
    return raw
  }
}

/** 浏览器工具卡片：trigger 显示动作与页面标题/URL；完成态截图直接平铺可放大，get_content 才展开正文。 */
export function BrowserTool(props: ToolProps) {
  const i18n = useI18n()
  const dialog = useDialog()
  const pending = () => props.status === "pending" || props.status === "running"
  const action = () => props.input.action
  // 目标 URL 优先取执行后固化的 metadata（交互动作回写当前页地址），运行中回落到输入参数。
  const url = () => text(props.metadata.url) ?? text(props.input.url)
  const pageTitle = () => text(props.metadata.title)
  const subtitle = createMemo(() => {
    const key = actionKey(action())
    const label = key ? i18n.t(key) : text(action()) ?? i18n.t("ui.tool.browser")
    // navigate 完成后副标题用页面标题更直观；其余动作用缩略 URL。
    const target = action() === "navigate" ? (pageTitle() ?? shortUrl(url() ?? "")) : shortUrl(url() ?? "")
    return target ? `${label} ${target}` : label
  })
  const images = createMemo(() => (props.attachments ?? []).filter((file) => file.mime.startsWith("image/")))
  // get_content 的页面正文需要完整展开；evaluate 的 JSON 结果同样保留。
  const content = createMemo(() => {
    if (action() !== "get_content" && action() !== "evaluate") return undefined
    const output = props.output
    if (!output) return undefined
    return output.length > CONTENT_LIMIT ? `${output.slice(0, CONTENT_LIMIT)}…` : output
  })
  // navigate/screenshot/click 等动作的正文是给模型的过程日志，不再平铺；仅留一行状态。
  const status = createMemo(() => {
    if (content() || images().length > 0) return undefined
    const output = props.output
    if (!output) return undefined
    return output.length > 200 ? `${output.slice(0, 200)}…` : output
  })
  const empty = createMemo(() => props.status !== "error" && !content() && !status() && images().length === 0)

  return (
    <BasicTool
      {...props}
      icon="window-cursor"
      allowPendingDetails
      hideDetails={empty()}
      forceOpen={pending() || props.status === "error"}
      trigger={{
        title: i18n.t("ui.tool.browser"),
        subtitle: subtitle(),
        subtitleClass: "browser-tool-subtitle",
      }}
    >
      <Show when={!empty()}>
        <div data-component="browser-tool-output">
          <Show when={props.status === "error" && props.error}>
            <div role="alert">{props.error}</div>
          </Show>
          <Show when={status()}>
            <div data-slot="browser-tool-status">{status()}</div>
          </Show>
          <Show when={content()}>
            <ScrollView data-slot="browser-tool-content-scroll">
              <pre>{content()}</pre>
            </ScrollView>
          </Show>
          <For each={images()}>
            {(file) => (
              <button
                type="button"
                data-slot="browser-tool-screenshot"
                title={url()}
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
