import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { Card } from "@opencode-ai/ui/card"
import { Icon } from "@opencode-ai/ui/icon"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { animateProcessChevron, animateProcessHide, animateProcessReveal } from "@opencode-ai/ui/hooks/gsap-surface"
import { Markdown } from "./markdown"

/**
 * 后台子代理任务结束时注入主会话的 <task> 信封解析结果
 * 由 task / task_async 工具在后台任务完成或失败时以 synthetic 用户消息写入。
 */
export interface TaskNotification {
  /** 子代理会话 ID */
  sessionID?: string
  /** 任务终态 */
  state: "completed" | "error"
  /** 服务端生成的摘要行（如 "Background task completed: ..."），原样展示 */
  summary?: string
  /** 子代理返回的正文（markdown） */
  text: string
}

const ENVELOPE = /^\s*<task([^>]*)>([\s\S]*?)<\/task>\s*$/
const SUMMARY = /<summary>([\s\S]*?)<\/summary>/

/**
 * 解析 synthetic 文本中的 <task> 完成通知
 * 仅接受终态（completed / error）；格式不符时返回 undefined，调用方按普通隐藏 synthetic 处理。
 *
 * @param text synthetic 文本内容
 * @return 解析出的任务通知，无法解析时为 undefined
 */
export function parseTaskNotification(text: string): TaskNotification | undefined {
  const match = ENVELOPE.exec(text)
  if (!match) return
  const attrs = match[1] ?? ""
  const state = /\bstate="([^"]+)"/.exec(attrs)?.[1]
  if (state !== "completed" && state !== "error") return
  const inner = match[2] ?? ""
  const tag = state === "error" ? "task_error" : "task_result"
  const open = inner.indexOf(`<${tag}>`)
  const close = inner.lastIndexOf(`</${tag}>`)
  const body = open !== -1 && close > open ? inner.slice(open + tag.length + 2, close) : inner
  const summary = SUMMARY.exec(inner)?.[1]?.trim()
  return {
    sessionID: /\bid="([^"]+)"/.exec(attrs)?.[1],
    state,
    summary: summary || undefined,
    text: body.trim(),
  }
}

/**
 * 后台任务完成通知卡片
 * 展示子代理回报给主代理的消息：标题为服务端摘要，正文默认折叠；
 * 展开 / 收起与时间线「已处理」摘要共用 GSAP reveal / hide 动画。
 */
export function TaskNotificationCard(props: { notification: TaskNotification }) {
  const i18n = useI18n()
  const error = createMemo(() => props.notification.state === "error")
  const title = createMemo(() => props.notification.summary || i18n.t("ui.taskNotification.title"))
  const [open, setOpen] = createSignal(false)
  // 收起动画播完前保持正文挂载，避免 DOM 瞬间消失
  const [bodyMounted, setBodyMounted] = createSignal(false)
  const [toggling, setToggling] = createSignal(false)
  let bodyEl: HTMLDivElement | undefined
  let chevron: HTMLElement | undefined

  createEffect(() => {
    animateProcessChevron(chevron, open())
  })

  const playOpen = () => {
    setOpen(true)
    setBodyMounted(true)
    requestAnimationFrame(() => {
      const targets = bodyEl ? Array.from(bodyEl.children) : []
      animateProcessReveal(targets.length > 0 ? targets : bodyEl)
    })
  }

  const playClose = async () => {
    if (toggling()) return
    setToggling(true)
    const targets = bodyEl ? Array.from(bodyEl.children) : []
    await animateProcessHide(targets.length > 0 ? targets : bodyEl)
    setOpen(false)
    setBodyMounted(false)
    setToggling(false)
  }

  const toggle = () => {
    if (toggling()) return
    if (open()) void playClose()
    else playOpen()
  }

  return (
    <Card data-kind="task-notification" data-open={open() ? "true" : "false"} variant={error() ? "error" : "normal"}>
      <button type="button" data-slot="task-notification-trigger" aria-expanded={open()} onClick={toggle}>
        <span data-slot="task-notification-icon">
          <Icon name={error() ? "circle-ban-sign" : "subagent"} size="small" style={{ "stroke-width": 1.5 }} />
        </span>
        <span data-slot="task-notification-title">{title()}</span>
        <span
          data-slot="task-notification-chevron"
          ref={(el) => {
            chevron = el
            animateProcessChevron(el, open())
          }}
        >
          <Icon name="chevron-right" size="small" />
        </span>
      </button>
      <Show when={bodyMounted()}>
        <div
          ref={(el) => {
            bodyEl = el
          }}
          data-slot="task-notification-content"
        >
          <Markdown text={props.notification.text} />
        </div>
      </Show>
    </Card>
  )
}
