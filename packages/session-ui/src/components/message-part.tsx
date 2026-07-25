import {
  Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onMount,
  Show,
  Switch,
  onCleanup,
  Index,
  type JSX,
  type ComponentProps,
} from "solid-js"
import { createStore } from "solid-js/store"
import stripAnsi from "strip-ansi"
import { Dynamic } from "solid-js/web"
import {
  AgentPart,
  AssistantMessage,
  FilePart,
  Message as MessageType,
  Part as PartType,
  ReasoningPart,
  Session,
  TextPart,
  ToolPart,
  UserMessage,
  Todo,
  QuestionAnswer,
  QuestionInfo,
} from "@opencode-ai/sdk/v2"
import { useData } from "../context"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { type UiI18n, useI18n } from "@opencode-ai/ui/context/i18n"
import { BasicTool, GenericTool } from "./basic-tool"
import { Accordion } from "@opencode-ai/ui/accordion"
import { StickyAccordionHeader } from "@opencode-ai/ui/sticky-accordion-header"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { ToolErrorCard } from "./tool-error-card"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { DiffChanges } from "@opencode-ai/ui/diff-changes"
import { Markdown } from "./markdown"
import { ImagePreview } from "@opencode-ai/ui/image-preview"
import { getDirectory as _getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { checksum } from "@opencode-ai/core/util/encode"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { TextShimmer } from "@opencode-ai/ui/text-shimmer"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Card, CardDescription, CardTitle } from "@opencode-ai/ui/card"
import { AnimatedCountList } from "./tool-count-summary"
import { ToolStatusTitle } from "./tool-status-title"
import { patchFiles } from "./apply-patch-file"
import { parseTaskNotification, TaskNotificationCard } from "./task-notification"
import { useLocation } from "@solidjs/router"
import { animateOutputEnter, animateShellSubtitle } from "@opencode-ai/ui/hooks/gsap-surface"
import { attached, inline, kind } from "./message-file"
import { isLastTextualPart, readPartText } from "./message-part-text"

async function writeClipboard(text: string): Promise<boolean> {
  const body = typeof document === "undefined" ? undefined : document.body
  if (body) {
    const textarea = document.createElement("textarea")
    textarea.value = text
    textarea.setAttribute("readonly", "")
    textarea.style.position = "fixed"
    textarea.style.opacity = "0"
    textarea.style.pointerEvents = "none"
    body.appendChild(textarea)
    textarea.select()
    const copied = document.execCommand("copy")
    body.removeChild(textarea)
    if (copied) return true
  }

  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
  if (!clipboard?.writeText) return false
  return clipboard.writeText(text).then(
    () => true,
    () => false,
  )
}

function ShellSubmessage(props: { text: string; animate?: boolean }) {
  let widthRef: HTMLSpanElement | undefined
  let valueRef: HTMLSpanElement | undefined

  onMount(() => {
    if (!props.animate) return
    requestAnimationFrame(() => animateShellSubtitle(widthRef, valueRef))
  })

  return (
    <span data-component="shell-submessage">
      <span ref={widthRef} data-slot="shell-submessage-width" style={{ width: props.animate ? "0px" : undefined }}>
        <span data-slot="basic-tool-tool-subtitle">
          <span
            ref={valueRef}
            data-slot="shell-submessage-value"
            style={props.animate ? { opacity: 0, filter: "blur(2px)" } : undefined}
          >
            {props.text}
          </span>
        </span>
      </span>
    </span>
  )
}

interface Diagnostic {
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  message: string
  severity?: number
}

function getDiagnostics(
  diagnosticsByFile: Record<string, Diagnostic[]> | undefined,
  filePath: string | undefined,
): Diagnostic[] {
  if (!diagnosticsByFile || !filePath) return []
  const diagnostics = diagnosticsByFile[filePath] ?? []
  return diagnostics.filter((d) => d.severity === 1).slice(0, 3)
}

function DiagnosticsDisplay(props: { diagnostics: Diagnostic[] }): JSX.Element {
  const i18n = useI18n()
  return (
    <Show when={props.diagnostics.length > 0}>
      <div data-component="diagnostics">
        <For each={props.diagnostics}>
          {(diagnostic) => (
            <div data-slot="diagnostic">
              <span data-slot="diagnostic-label">{i18n.t("ui.messagePart.diagnostic.error")}</span>
              <span data-slot="diagnostic-location">
                [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}]
              </span>
              <span data-slot="diagnostic-message">{diagnostic.message}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

export interface MessageProps {
  message: MessageType
  parts: PartType[]
  actions?: UserActions
  showAssistantCopyPartID?: string | null
  showReasoningSummaries?: boolean
}

export type SessionAction = (input: { sessionID: string; messageID: string }) => Promise<void> | void

export type UserActions = {
  fork?: SessionAction
  revert?: SessionAction
  replay?: SessionAction
  openAttachment?: (file: FilePart) => void
}

export interface MessagePartProps {
  part: PartType
  message: MessageType
  hideDetails?: boolean
  defaultOpen?: boolean
  toolOpen?: boolean
  onToolOpenChange?: (open: boolean) => void
  deferToolContent?: boolean
  virtualizeDiff?: boolean
  onContentRendered?: () => void
  showAssistantCopyPartID?: string | null
  turnDurationMs?: number
  onViewFile?: (file: string) => void
}

function MessageActionButton(
  props: Pick<ComponentProps<"button">, "disabled" | "onMouseDown" | "onClick" | "aria-label"> & {
    icon: "arrow-up" | "check" | "copy" | "reset"
    label: JSX.Element
  },
) {
  return (
    <Tooltip value={props.label} placement="top" gutter={4}>
      <IconButton
        icon={props.icon}
        size="normal"
        variant="ghost"
        disabled={props.disabled}
        onMouseDown={props.onMouseDown}
        onClick={props.onClick}
        aria-label={props["aria-label"]}
      />
    </Tooltip>
  )
}

export type PartComponent = Component<MessagePartProps>

export const PART_MAPPING: Record<string, PartComponent | undefined> = {}

const TEXT_RENDER_SNAP = /[\s.,!?;:)\]]/

/** chars/sec — higher backlog = faster catch-up, never hard-snap (that stutters). */
function streamCps(backlog: number) {
  if (backlog > 800) return 520
  if (backlog > 320) return 280
  if (backlog > 120) return 160
  if (backlog > 40) return 110
  return 72
}

function createPacedValue(getValue: () => string, live?: () => boolean) {
  const [value, setValue] = createSignal(getValue())
  let shown = getValue()
  let raf = 0
  let last = 0
  let carry = 0

  const clear = () => {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    last = 0
    carry = 0
  }

  const sync = (text: string) => {
    shown = text
    setValue(text)
  }

  const tick = (now: number) => {
    raf = 0
    const text = getValue()
    if (!live?.()) {
      sync(text)
      return
    }
    if (!text.startsWith(shown) || text.length < shown.length) {
      sync(text)
      return
    }
    if (text.length === shown.length) {
      last = 0
      carry = 0
      return
    }

    const dt = last === 0 ? 1 / 60 : Math.min(0.048, (now - last) / 1000)
    last = now
    const backlog = text.length - shown.length
    carry += streamCps(backlog) * dt
    let advance = Math.floor(carry)
    if (advance < 1) {
      raf = requestAnimationFrame(tick)
      return
    }
    carry -= advance
    // Prefer breaking on punctuation/space within a tiny window.
    let end = Math.min(text.length, shown.length + advance)
    const max = Math.min(text.length, end + 6)
    for (let i = end; i < max; i++) {
      if (TEXT_RENDER_SNAP.test(text[i] ?? "")) {
        end = i + 1
        break
      }
    }
    sync(text.slice(0, end))
    if (end < text.length) raf = requestAnimationFrame(tick)
  }

  createEffect(() => {
    const text = getValue()
    if (!live?.()) {
      clear()
      sync(text)
      return
    }
    if (!text.startsWith(shown) || text.length < shown.length) {
      clear()
      sync(text)
      return
    }
    if (text.length === shown.length) return
    if (raf) return
    raf = requestAnimationFrame(tick)
  })

  onCleanup(() => {
    clear()
  })

  return value
}

function PacedMarkdown(props: { text: string; cacheKey: string; streaming: boolean }) {
  const value = createPacedValue(
    () => props.text,
    () => props.streaming,
  )

  return (
    <Show when={value()}>
      <Markdown text={value()} cacheKey={props.cacheKey} streaming={props.streaming} />
    </Show>
  )
}

function relativizeProjectPath(path: string, directory?: string) {
  if (!path) return ""
  if (!directory) return path
  if (directory === "/") return path
  if (directory === "\\") return path
  if (path === directory) return ""

  const separator = directory.includes("\\") ? "\\" : "/"
  const prefix = directory.endsWith(separator) ? directory : directory + separator
  if (!path.startsWith(prefix)) return path
  return path.slice(directory.length)
}

function getDirectory(path: string | undefined) {
  const data = useData()
  return relativizeProjectPath(_getDirectory(path), data.directory)
}

import type { IconProps } from "@opencode-ai/ui/icon"
import { normalize, resolveFileDiff } from "./session-diff"

export type ToolInfo = {
  icon: IconProps["name"]
  title: string
  subtitle?: string
}

function agentTitle(i18n: UiI18n, type?: string) {
  if (!type) return i18n.t("ui.tool.agent.default")
  return i18n.t("ui.tool.agent", { type })
}

const agentTones: Record<string, string> = {
  ask: "var(--icon-agent-ask-base)",
  build: "var(--icon-agent-build-base)",
  docs: "var(--icon-agent-docs-base)",
  plan: "var(--icon-agent-plan-base)",
}

const v2AgentTones: Record<string, string> = {
  build: "var(--v2-agent-build-solid)",
  explore: "var(--v2-agent-explore-solid)",
  plan: "var(--v2-agent-plan-solid)",
  review: "var(--v2-agent-review-solid)",
  writer: "var(--v2-agent-writer-solid)",
}

const agentThemeColors: Record<string, string> = {
  primary: "var(--text-interactive-base)",
  secondary: "var(--text-base)",
  accent: "var(--icon-info-base)",
  success: "var(--icon-success-base)",
  warning: "var(--icon-warning-base)",
  error: "var(--icon-critical-base)",
  info: "var(--icon-info-base)",
}

const v2AgentThemeColors: Record<string, string> = {
  primary: "var(--v2-text-text-accent)",
  secondary: "var(--v2-text-text-muted)",
  accent: "var(--v2-icon-icon-accent)",
  success: "var(--v2-state-fg-success)",
  warning: "var(--v2-state-fg-warning)",
  error: "var(--v2-state-fg-danger)",
  info: "var(--v2-state-fg-info)",
}

const agentPalette = [
  "var(--icon-agent-ask-base)",
  "var(--icon-agent-build-base)",
  "var(--icon-agent-docs-base)",
  "var(--icon-agent-plan-base)",
  "var(--syntax-info)",
  "var(--syntax-success)",
  "var(--syntax-warning)",
  "var(--syntax-property)",
  "var(--syntax-constant)",
  "var(--text-diff-add-base)",
  "var(--text-diff-delete-base)",
  "var(--icon-warning-base)",
]

function tone(name: string) {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return agentPalette[hash % agentPalette.length]
}

function taskAgent(
  raw: unknown,
  list?: readonly { name: string; color?: string }[],
): { name?: string; color?: string; v2Color?: string } {
  if (typeof raw !== "string" || !raw) return {}
  const key = raw.toLowerCase()
  const item = list?.find((entry) => entry.name === raw || entry.name.toLowerCase() === key)
  const v2Tone = item?.color ? undefined : v2AgentTones[key]
  const color = agentColor(item?.color, agentThemeColors) ?? agentTones[key] ?? tone(key)
  const v2Color = agentColor(item?.color, v2AgentThemeColors) ?? v2Tone ?? color
  return {
    name: item?.name ?? `${raw[0]!.toUpperCase()}${raw.slice(1)}`,
    color,
    v2Color,
  }
}

function agentColor(value: string | undefined, themeColors: Record<string, string>) {
  if (!value) return
  return themeColors[value] ?? value
}

function webSearchProviderLabel(provider: unknown) {
  if (provider === "parallel") return "Parallel Web Search"
  if (provider === "exa") return "Exa Web Search"
  return "Web Search"
}

function shortId(value: string) {
  if (value.length <= 18) return value
  return `${value.slice(0, 10)}…${value.slice(-4)}`
}

function taskManageSubtitle(input: Record<string, any> = {}, metadata: Record<string, unknown> = {}) {
  if (typeof input.batch_id === "string" && input.batch_id) return shortId(input.batch_id)
  if (typeof metadata.batch_id === "string" && metadata.batch_id) return shortId(metadata.batch_id as string)
  if (typeof input.task_id === "string" && input.task_id) return shortId(input.task_id)
  if (typeof metadata.task_id === "string" && metadata.task_id) return shortId(metadata.task_id as string)
  if (Array.isArray(input.task_ids) && input.task_ids.length > 0) {
    if (input.task_ids.length === 1 && typeof input.task_ids[0] === "string") return shortId(input.task_ids[0])
    return `${input.task_ids.length} tasks`
  }
  if (Array.isArray(metadata.task_ids) && metadata.task_ids.length > 0) {
    if (metadata.task_ids.length === 1 && typeof metadata.task_ids[0] === "string") {
      return shortId(metadata.task_ids[0] as string)
    }
    return `${metadata.task_ids.length} tasks`
  }
  if (typeof metadata.status === "string" && metadata.status) return metadata.status
  if (typeof metadata.count === "number") return `${metadata.count} tasks`
  return undefined
}

function taskManageSessionId(input: Record<string, any> = {}, metadata: Record<string, unknown> = {}) {
  if (typeof input.task_id === "string" && input.task_id) return input.task_id
  if (typeof metadata.task_id === "string" && metadata.task_id) return metadata.task_id as string
  if (typeof metadata.session_id === "string" && metadata.session_id) return metadata.session_id as string
  if (typeof metadata.sessionId === "string" && metadata.sessionId) return metadata.sessionId as string
  if (Array.isArray(input.task_ids) && typeof input.task_ids[0] === "string") return input.task_ids[0] as string
  if (Array.isArray(metadata.task_ids) && typeof metadata.task_ids[0] === "string") {
    return metadata.task_ids[0] as string
  }
}

export function getToolInfo(
  tool: string,
  input: any = {},
  metadata: Record<string, unknown> | undefined = {},
): ToolInfo {
  const i18n = useI18n()
  switch (tool) {
    case "read":
      return {
        icon: "glasses",
        title: i18n.t("ui.tool.read"),
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
      }
    case "list_dir":
      return {
        icon: "bullet-list",
        title: i18n.t("ui.tool.list"),
        subtitle: input.path ? getFilename(input.path) : undefined,
      }
    case "glob":
      return {
        icon: "magnifying-glass-menu",
        title: i18n.t("ui.tool.glob"),
        subtitle: input.pattern,
      }
    case "grep":
      return {
        icon: "magnifying-glass-menu",
        title: i18n.t("ui.tool.grep"),
        subtitle: input.pattern,
      }
    case "history_grep":
      return {
        icon: "archive",
        title: i18n.t("ui.tool.historyGrep"),
        subtitle: input.pattern,
      }
    case "history_list":
      return {
        icon: "archive",
        title: i18n.t("ui.tool.historyList"),
        subtitle: input.chunk_id,
      }
    case "webfetch":
      return {
        icon: "window-cursor",
        title: i18n.t("ui.tool.webfetch"),
        subtitle: input.url,
      }
    case "websearch":
      return {
        icon: "window-cursor",
        title: webSearchProviderLabel(metadata?.provider),
        subtitle: input.query,
      }
    case "task":
    case "task_async": {
      const metaTasks = Array.isArray(metadata?.tasks) ? metadata.tasks : undefined
      const inputTasks = Array.isArray(input.tasks) ? input.tasks : undefined
      const batch = (metaTasks?.length ? metaTasks : inputTasks) as unknown[] | undefined
      const first = batch?.[0] && typeof batch[0] === "object" ? (batch[0] as Record<string, unknown>) : undefined
      const rawType =
        (typeof input.subagent_type === "string" && input.subagent_type) ||
        (typeof input.agent === "string" && input.agent) ||
        (typeof metadata?.agent === "string" && metadata.agent) ||
        (typeof first?.subagent_type === "string" && first.subagent_type) ||
        (typeof first?.agent === "string" && first.agent) ||
        undefined
      const type = rawType ? rawType[0]!.toUpperCase() + rawType.slice(1) : undefined
      const batchCount = batch?.length ?? 0
      const description =
        (typeof input.description === "string" && input.description) ||
        (typeof metadata?.description === "string" && metadata.description) ||
        (typeof metadata?.title === "string" && metadata.title) ||
        (typeof first?.description === "string" && first.description) ||
        (typeof first?.title === "string" && first.title) ||
        undefined
      const bg = metadata?.background === true ? " (background)" : ""
      return {
        icon: "task",
        title: batchCount > 1 ? `${batchCount} tasks` : agentTitle(i18n, type),
        subtitle:
          batchCount > 1
            ? `${batchCount} child sessions${bg}`
            : description
              ? `${description}${bg}`
              : bg
                ? bg.trim()
                : undefined,
      }
    }
    case "task_async_status":
      return {
        icon: "task",
        title: i18n.t("ui.tool.task.status"),
        subtitle: taskManageSubtitle(input, metadata),
      }
    case "task_async_wait":
      return {
        icon: "task",
        title: i18n.t("ui.tool.task.wait"),
        subtitle: taskManageSubtitle(input, metadata),
      }
    case "task_async_abort":
      return {
        icon: "task",
        title: i18n.t("ui.tool.task.abort"),
        subtitle: taskManageSubtitle(input, metadata),
      }
    case "task_async_followup": {
      const rawType =
        (typeof input.agent === "string" && input.agent) ||
        (typeof metadata?.agent === "string" && metadata.agent) ||
        undefined
      const type = rawType ? rawType[0]!.toUpperCase() + rawType.slice(1) : undefined
      const description = taskFollowupDescription(
        (typeof metadata?.title === "string" && metadata.title) ||
          (typeof input.title === "string" && input.title) ||
          (typeof input.prompt === "string" && input.prompt) ||
          taskManageSubtitle(input, metadata),
      )
      const bg = metadata?.background === true ? " (background)" : ""
      return {
        icon: "task",
        title: agentTitle(i18n, type),
        subtitle: description ? `${description}${bg}` : bg ? bg.trim() : undefined,
      }
    }
    case "bash":
      return {
        icon: "console",
        title: i18n.t("ui.tool.shell"),
        subtitle: input.command,
      }
    case "edit":
      return {
        icon: "code-lines",
        title: i18n.t("ui.messagePart.title.edit"),
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
      }
    case "multiedit":
      return {
        icon: "code-lines",
        title: i18n.t("ui.messagePart.title.multiedit"),
        subtitle: input.edits?.length
          ? `${input.edits.length} ${i18n.t(input.edits.length > 1 ? "ui.common.file.other" : "ui.common.file.one")}`
          : undefined,
      }
    case "write":
      return {
        icon: "code-lines",
        title: i18n.t("ui.messagePart.title.write"),
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
      }
    case "apply_patch":
      return {
        icon: "code-lines",
        title: i18n.t("ui.tool.patch"),
        subtitle: input.files?.length
          ? `${input.files.length} ${i18n.t(input.files.length > 1 ? "ui.common.file.other" : "ui.common.file.one")}`
          : undefined,
      }
    case "todowrite":
      return {
        icon: "checklist",
        title: i18n.t("ui.tool.todos"),
      }
    case "question":
      return {
        icon: "bubble-5",
        title: i18n.t("ui.tool.questions"),
      }
    case "skill":
      return {
        icon: "brain",
        title: input.name || i18n.t("ui.tool.skill"),
      }
    default:
      return {
        icon: "mcp",
        title: tool,
      }
  }
}

function urls(text: string | undefined) {
  if (!text) return []
  const seen = new Set<string>()
  return [...text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)]
    .map((item) => item[0].replace(/[),.;:!?]+$/g, ""))
    .filter((item) => {
      if (seen.has(item)) return false
      seen.add(item)
      return true
    })
}

function sessionLink(
  id: string | undefined,
  path: string,
  href?: (id: string, directory?: string) => string | undefined,
  directory?: string,
) {
  if (!id) return

  const direct = href?.(id, directory)
  if (direct) return direct

  const idx = path.indexOf("/session")
  if (idx === -1) return
  return `${path.slice(0, idx)}/session/${id}`
}

function currentSession(path: string) {
  return path.match(/\/session\/([^/?#]+)/)?.[1]
}

function taskSession(
  input: Record<string, any>,
  path: string,
  sessions: Session[] | undefined,
  agents?: readonly { name: string; color?: string }[],
) {
  const parentID = currentSession(path)
  if (!parentID) return
  const description = typeof input.description === "string" ? input.description : ""
  const agent = taskAgent(input.subagent_type, agents).name
  return (sessions ?? [])
    .filter((session) => session.parentID === parentID && !session.time?.archived)
    .filter((session) => (description ? session.title.startsWith(description) : true))
    .filter((session) => (agent ? session.title.includes(`@${agent}`) : true))
    .sort((a, b) => (b.time.created ?? 0) - (a.time.created ?? 0))[0]?.id
}

const CONTEXT_GROUP_TOOLS = new Set(["read", "glob", "grep", "list_dir"])
const HIDDEN_TOOLS = new Set(["todowrite"])

function list<T>(value: T[] | undefined | null, fallback: T[]) {
  if (Array.isArray(value)) return value
  return fallback
}

function same<T>(a: readonly T[] | undefined, b: readonly T[] | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((x, i) => x === b[i])
}

export type PartRef = {
  messageID: string
  partID: string
}

export type PartGroup =
  | {
      key: string
      type: "part"
      ref: PartRef
    }
  | {
      key: string
      type: "context"
      refs: PartRef[]
    }

function sameRef(a: PartRef, b: PartRef) {
  return a.messageID === b.messageID && a.partID === b.partID
}

function sameGroup(a: PartGroup, b: PartGroup) {
  if (a === b) return true
  if (a.key !== b.key) return false
  if (a.type !== b.type) return false
  if (a.type === "part") {
    if (b.type !== "part") return false
    return sameRef(a.ref, b.ref)
  }
  if (b.type !== "context") return false
  if (a.refs.length !== b.refs.length) return false
  return a.refs.every((ref, i) => sameRef(ref, b.refs[i]!))
}

export function sameGroups(a: readonly PartGroup[] | undefined, b: readonly PartGroup[] | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((item, i) => sameGroup(item, b[i]!))
}

export function groupParts(parts: { messageID: string; part: PartType }[]) {
  const result: PartGroup[] = []
  let start = -1

  const flush = (end: number) => {
    if (start < 0) return
    const first = parts[start]
    const last = parts[end]
    if (!first || !last) {
      start = -1
      return
    }
    result.push({
      key: `context:${first.part.id}`,
      type: "context",
      refs: parts.slice(start, end + 1).map((item) => ({
        messageID: item.messageID,
        partID: item.part.id,
      })),
    })
    start = -1
  }

  parts.forEach((item, index) => {
    if (isContextGroupTool(item.part)) {
      if (start < 0) start = index
      return
    }

    flush(index - 1)
    result.push({
      key: `part:${item.messageID}:${item.part.id}`,
      type: "part",
      ref: {
        messageID: item.messageID,
        partID: item.part.id,
      },
    })
  })

  flush(parts.length - 1)
  return result
}

function index<T extends { id: string }>(items: readonly T[]) {
  return new Map(items.map((item) => [item.id, item] as const))
}

export function renderable(part: PartType, showReasoningSummaries = true) {
  if (part.type === "tool") {
    if (HIDDEN_TOOLS.has(part.tool)) return false
    if (part.tool === "question") return part.state.status !== "pending" && part.state.status !== "running"
    return true
  }
  if (part.type === "text") return !!part.text?.trim()
  if (part.type === "reasoning") return showReasoningSummaries && !!part.text?.trim()
  return !!PART_MAPPING[part.type]
}

/** Tools / reasoning are intermediate process; final text answers stay outside the collapse. */
export function isProcessPart(part: PartType) {
  if (part.type === "reasoning") return true
  // Keep interactive/completed question UI outside the process fold.
  if (part.type === "tool") return part.tool !== "question"
  return false
}

export function isProcessGroup(group: PartGroup, resolve: (ref: PartRef) => PartType | undefined) {
  if (group.type === "context") return true
  const part = resolve(group.ref)
  return !!part && isProcessPart(part)
}

function toolDefaultOpen(tool: string, shell = false, edit = false) {
  if (tool === "bash") return shell
  if (tool === "edit" || tool === "write" || tool === "apply_patch" || tool === "multiedit") return edit
}

export function partDefaultOpen(part: PartType, shell = false, edit = false) {
  if (part.type !== "tool") return
  return toolDefaultOpen(part.tool, shell, edit)
}

export function AssistantParts(props: {
  messages: AssistantMessage[]
  showAssistantCopyPartID?: string | null
  turnDurationMs?: number
  working?: boolean
  showReasoningSummaries?: boolean
  shellToolDefaultOpen?: boolean
  editToolDefaultOpen?: boolean
}) {
  const data = useData()
  const emptyParts: PartType[] = []
  const emptyTools: ToolPart[] = []
  const msgs = createMemo(() => index(props.messages))
  const part = createMemo(
    () =>
      new Map(
        props.messages.map((message) => [message.id, index(list(data.store.part?.[message.id], emptyParts))] as const),
      ),
  )

  const grouped = createMemo(
    () =>
      groupParts(
        props.messages.flatMap((message) =>
          list(data.store.part?.[message.id], emptyParts)
            .filter((part) => renderable(part, props.showReasoningSummaries ?? true))
            .map((part) => ({
              messageID: message.id,
              part,
            })),
        ),
      ),
    [] as PartGroup[],
    { equals: sameGroups },
  )

  const last = createMemo(() => grouped().at(-1)?.key)

  return (
    <Index each={grouped()}>
      {(entryAccessor) => {
        const entryType = createMemo(() => entryAccessor().type)

        return (
          <Switch>
            <Match when={entryType() === "context"}>
              {(() => {
                const parts = createMemo(
                  () => {
                    const entry = entryAccessor()
                    if (entry.type !== "context") return emptyTools
                    return entry.refs
                      .map((ref) => part().get(ref.messageID)?.get(ref.partID))
                      .filter((part): part is ToolPart => !!part && isContextGroupTool(part))
                  },
                  emptyTools,
                  { equals: same },
                )
                const busy = createMemo(() => props.working && last() === entryAccessor().key)

                return (
                  <Show when={parts().length > 0}>
                    <ContextToolGroup parts={parts()} busy={busy()} />
                  </Show>
                )
              })()}
            </Match>
            <Match when={entryType() === "part"}>
              {(() => {
                const message = createMemo(() => {
                  const entry = entryAccessor()
                  if (entry.type !== "part") return
                  return msgs().get(entry.ref.messageID)
                })
                const item = createMemo(() => {
                  const entry = entryAccessor()
                  if (entry.type !== "part") return
                  return part().get(entry.ref.messageID)?.get(entry.ref.partID)
                })

                return (
                  <Show when={message()}>
                    <Show when={item()}>
                      <Part
                        part={item()!}
                        message={message()!}
                        showAssistantCopyPartID={props.showAssistantCopyPartID}
                        turnDurationMs={props.turnDurationMs}
                        defaultOpen={partDefaultOpen(item()!, props.shellToolDefaultOpen, props.editToolDefaultOpen)}
                      />
                    </Show>
                  </Show>
                )
              })()}
            </Match>
          </Switch>
        )
      }}
    </Index>
  )
}

function isContextGroupTool(part: PartType): part is ToolPart {
  return part.type === "tool" && CONTEXT_GROUP_TOOLS.has(part.tool)
}

function contextToolDetail(part: ToolPart): string | undefined {
  const info = getToolInfo(
    part.tool,
    part.state.input ?? {},
    "metadata" in part.state ? part.state.metadata : undefined,
  )
  if (info.subtitle) return info.subtitle
  if (part.state.status === "error") return part.state.error
  if ((part.state.status === "running" || part.state.status === "completed") && part.state.title)
    return part.state.title
  const description = part.state.input?.description
  if (typeof description === "string") return description
  return undefined
}

function contextToolTrigger(part: ToolPart, i18n: ReturnType<typeof useI18n>) {
  const input = (part.state.input ?? {}) as Record<string, unknown>
  const path = typeof input.path === "string" ? input.path : "/"
  const filePath = typeof input.filePath === "string" ? input.filePath : undefined
  const pattern = typeof input.pattern === "string" ? input.pattern : undefined
  const include = typeof input.include === "string" ? input.include : undefined
  const offset = typeof input.offset === "number" ? input.offset : undefined
  const limit = typeof input.limit === "number" ? input.limit : undefined

  switch (part.tool) {
    case "read": {
      const args: string[] = []
      if (offset !== undefined) args.push("offset=" + offset)
      if (limit !== undefined) args.push("limit=" + limit)
      return {
        title: i18n.t("ui.tool.read"),
        subtitle: filePath ? getFilename(filePath) : "",
        args,
      }
    }
    case "list_dir":
      return {
        title: i18n.t("ui.tool.list"),
        subtitle: getDirectory((typeof input.path === "string" && input.path) || path || "/"),
      }
    case "glob":
      return {
        title: i18n.t("ui.tool.glob"),
        subtitle: getDirectory(path),
        args: pattern ? ["pattern=" + pattern] : [],
      }
    case "grep": {
      const args: string[] = []
      if (pattern) args.push("pattern=" + pattern)
      if (include) args.push("include=" + include)
      return {
        title: i18n.t("ui.tool.grep"),
        subtitle: getDirectory(path),
        args,
      }
    }
    case "history_grep": {
      const args: string[] = []
      if (typeof input.chunk_id === "string" && input.chunk_id) args.push("chunk=" + input.chunk_id)
      return {
        title: i18n.t("ui.tool.historyGrep"),
        subtitle: typeof input.pattern === "string" ? input.pattern : "",
        args,
      }
    }
    case "history_list": {
      const args: string[] = []
      if (typeof input.offset === "number") args.push("offset=" + input.offset)
      if (typeof input.limit === "number") args.push("limit=" + input.limit)
      return {
        title: i18n.t("ui.tool.historyList"),
        subtitle: typeof input.chunk_id === "string" ? input.chunk_id : "",
        args,
      }
    }
    default: {
      const info = getToolInfo(part.tool, input, "metadata" in part.state ? part.state.metadata : undefined)
      return {
        title: info.title,
        subtitle: info.subtitle || contextToolDetail(part),
        args: [],
      }
    }
  }
}

function contextToolSummary(parts: ToolPart[]) {
  const read = parts.filter((part) => part.tool === "read").length
  const search = parts.filter((part) => part.tool === "glob" || part.tool === "grep").length
  const list = parts.filter((part) => part.tool === "list_dir").length
  return { read, search, list }
}

function ExaOutput(props: { output?: string }) {
  const links = createMemo(() => urls(props.output))

  return (
    <Show when={links().length > 0}>
      <div data-component="exa-tool-output">
        <div data-slot="exa-tool-links">
          <For each={links()}>
            {(url) => (
              <a
                data-slot="exa-tool-link"
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => event.stopPropagation()}
              >
                {url}
              </a>
            )}
          </For>
        </div>
      </div>
    </Show>
  )
}

export function registerPartComponent(type: string, component: PartComponent) {
  PART_MAPPING[type] = component
}

export function Message(props: MessageProps) {
  return (
    <Switch>
      <Match when={props.message.role === "user" && props.message}>
        {(userMessage) => (
          <UserMessageDisplay
            message={userMessage() as UserMessage}
            parts={props.parts}
            actions={props.actions}
          />
        )}
      </Match>
      <Match when={props.message.role === "assistant" && props.message}>
        {(assistantMessage) => (
          <AssistantMessageDisplay
            message={assistantMessage() as AssistantMessage}
            parts={props.parts}
            showAssistantCopyPartID={props.showAssistantCopyPartID}
            showReasoningSummaries={props.showReasoningSummaries}
          />
        )}
      </Match>
    </Switch>
  )
}

export function AssistantMessageDisplay(props: {
  message: AssistantMessage
  parts: PartType[]
  showAssistantCopyPartID?: string | null
  showReasoningSummaries?: boolean
}) {
  const emptyTools: ToolPart[] = []
  const part = createMemo(() => index(props.parts))
  const grouped = createMemo(
    () =>
      groupParts(
        props.parts
          .filter((part) => renderable(part, props.showReasoningSummaries ?? true))
          .map((part) => ({
            messageID: props.message.id,
            part,
          })),
      ),
    [] as PartGroup[],
    { equals: sameGroups },
  )

  return (
    <Index each={grouped()}>
      {(entryAccessor) => {
        const entryType = createMemo(() => entryAccessor().type)

        return (
          <Switch>
            <Match when={entryType() === "context"}>
              {(() => {
                const parts = createMemo(
                  () => {
                    const entry = entryAccessor()
                    if (entry.type !== "context") return emptyTools
                    return entry.refs
                      .map((ref) => part().get(ref.partID))
                      .filter((part): part is ToolPart => !!part && isContextGroupTool(part))
                  },
                  emptyTools,
                  { equals: same },
                )

                return (
                  <Show when={parts().length > 0}>
                    <ContextToolGroup parts={parts()} />
                  </Show>
                )
              })()}
            </Match>
            <Match when={entryType() === "part"}>
              {(() => {
                const item = createMemo(() => {
                  const entry = entryAccessor()
                  if (entry.type !== "part") return
                  return part().get(entry.ref.partID)
                })

                return (
                  <Show when={item()}>
                    <Part
                      part={item()!}
                      message={props.message}
                      showAssistantCopyPartID={props.showAssistantCopyPartID}
                    />
                  </Show>
                )
              })()}
            </Match>
          </Switch>
        )
      }}
    </Index>
  )
}

export function ContextToolGroup(props: {
  parts: ToolPart[]
  busy?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onSizeChange?: () => void
}) {
  const i18n = useI18n()
  const [localOpen, setLocalOpen] = createSignal(false)
  const open = () => props.open ?? localOpen()
  const pending = createMemo(
    () =>
      !!props.busy || props.parts.some((part) => part.state.status === "pending" || part.state.status === "running"),
  )
  const summary = createMemo(() => contextToolSummary(props.parts))
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
        <div data-component="context-tool-group-trigger">
          <span
            data-slot="context-tool-group-title"
            class="min-w-0 flex items-center gap-2 text-14-medium text-text-strong"
          >
            <span data-slot="context-tool-group-label" class="shrink-0">
              <ToolStatusTitle
                active={pending()}
                activeText={i18n.t("ui.sessionTurn.status.gatheringContext")}
                doneText={i18n.t("ui.sessionTurn.status.gatheredContext")}
                split={false}
              />
            </span>
            <span
              data-slot="context-tool-group-summary"
              class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-normal text-text-base"
            >
              <AnimatedCountList
                items={[
                  {
                    key: "read",
                    count: summary().read,
                    one: i18n.t("ui.messagePart.context.read.one"),
                    other: i18n.t("ui.messagePart.context.read.other"),
                  },
                  {
                    key: "search",
                    count: summary().search,
                    one: i18n.t("ui.messagePart.context.search.one"),
                    other: i18n.t("ui.messagePart.context.search.other"),
                  },
                  {
                    key: "list",
                    count: summary().list,
                    one: i18n.t("ui.messagePart.context.list.one"),
                    other: i18n.t("ui.messagePart.context.list.other"),
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
        <div data-component="context-tool-group-list">
          <Index each={props.parts}>
            {(partAccessor) => {
              const trigger = createMemo(() => contextToolTrigger(partAccessor(), i18n))
              const running = createMemo(
                () => partAccessor().state.status === "pending" || partAccessor().state.status === "running",
              )
              return (
                <div data-slot="context-tool-group-item">
                  <div data-component="tool-trigger">
                    <div data-slot="basic-tool-tool-trigger-content">
                      <div data-slot="basic-tool-tool-info">
                        <div data-slot="basic-tool-tool-info-structured">
                          <div data-slot="basic-tool-tool-info-main">
                            <span data-slot="basic-tool-tool-title">
                              <TextShimmer text={trigger().title} active={running()} />
                            </span>
                            <Show when={!running() && trigger().subtitle}>
                              <span data-slot="basic-tool-tool-subtitle">{trigger().subtitle}</span>
                            </Show>
                            <Show when={!running() && trigger().args?.length}>
                              <For each={trigger().args}>
                                {(arg) => <span data-slot="basic-tool-tool-arg">{arg}</span>}
                              </For>
                            </Show>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )
            }}
          </Index>
        </div>
      </Collapsible.Content>
    </Collapsible>
  )
}

export function UserMessageDisplay(props: {
  message: UserMessage
  parts: PartType[]
  actions?: UserActions
}) {
  const data = useData()
  const dialog = useDialog()
  const i18n = useI18n()
  const [state, setState] = createStore({
    copied: false,
    busy: false,
  })
  const copied = () => state.copied
  const busy = () => state.busy

  const textPart = createMemo(
    () => props.parts?.find((p) => p.type === "text" && !(p as TextPart).synthetic) as TextPart | undefined,
  )

  // 后台子代理任务结束时注入的 <task> 通知是 synthetic 用户消息，需要解析出来可见渲染
  const taskNotifications = createMemo(() =>
    (props.parts ?? []).flatMap((p) => {
      if (p.type !== "text" || !(p as TextPart).synthetic) return []
      const notification = parseTaskNotification((p as TextPart).text)
      return notification ? [notification] : []
    }),
  )

  const text = createMemo(() => textPart()?.text || "")

  const files = createMemo(() => (props.parts?.filter((p) => p.type === "file") as FilePart[]) ?? [])

  const attachments = createMemo(() => files().filter(attached))

  const inlineFiles = createMemo(() => files().filter(inline))

  const agents = createMemo(() => (props.parts?.filter((p) => p.type === "agent") as AgentPart[]) ?? [])

  const model = createMemo(() => {
    const providerID = props.message.model?.providerID
    const modelID = props.message.model?.modelID
    if (!providerID || !modelID) return ""
    const match = data.store.provider?.all?.get(providerID)
    return match?.models?.[modelID]?.name ?? modelID
  })
  const timefmt = createMemo(() => new Intl.DateTimeFormat(i18n.locale(), { timeStyle: "short" }))

  const stamp = createMemo(() => {
    const created = props.message.time?.created
    if (typeof created !== "number") return ""
    return timefmt().format(created)
  })

  const metaHead = createMemo(() => {
    const agent = props.message.agent
    const items = [agent ? agent[0]?.toUpperCase() + agent.slice(1) : "", model(), props.message.model?.variant ?? ""]
    return items.filter((x) => !!x).join("\u00A0\u00B7\u00A0")
  })

  const metaTail = stamp

  const openImagePreview = (url: string, alt?: string) => {
    dialog.show(() => <ImagePreview src={url} alt={alt} />)
  }

  const handleCopy = async () => {
    const content = text()
    if (!content) return
    if (await writeClipboard(content)) {
      setState("copied", true)
      setTimeout(() => setState("copied", false), 2000)
    }
  }

  const runAction = (act: SessionAction | undefined) => {
    if (!act || busy()) return
    setState("busy", true)
    void Promise.resolve()
      .then(() =>
        act({
          sessionID: props.message.sessionID,
          messageID: props.message.id,
        }),
      )
      .finally(() => setState("busy", false))
  }

  const revert = () => runAction(props.actions?.revert)
  const replay = () => runAction(props.actions?.replay)

  const renderAttachments = () => (
    <Show when={attachments().length > 0}>
      <div data-slot="user-message-attachments">
        <For each={attachments()}>
          {(file) => {
            const type = kind(file)
            const name = file.filename ?? i18n.t("ui.message.attachment.alt")

            return (
              <div
                data-slot="user-message-attachment"
                data-type={type}
                data-clickable={type === "image" ? "true" : undefined}
                title={type === "file" ? name : undefined}
                onClick={() => {
                  if (type === "image") openImagePreview(file.url, name)
                }}
              >
                <Show
                  when={type === "image"}
                  fallback={
                    <div data-slot="user-message-attachment-file">
                      <FileIcon node={{ path: name, type: "file" }} />
                      <span data-slot="user-message-attachment-name">{name}</span>
                    </div>
                  }
                >
                  <img data-slot="user-message-attachment-image" src={file.url} alt={name} />
                </Show>
              </div>
            )
          }}
        </For>
      </div>
    </Show>
  )

  return (
    <div data-component="user-message" data-timeline-part-id={textPart()?.id}>
      {renderAttachments()}
      <For each={taskNotifications()}>{(notification) => <TaskNotificationCard notification={notification} />}</For>
      <Show when={text()}>
        <div data-slot="user-message-body">
          <div data-slot="user-message-text">
            <HighlightedText text={text()} references={inlineFiles()} agents={agents()} />
          </div>
        </div>
      </Show>
      <Show when={text()}>
        <div data-slot="user-message-copy-wrapper">
          <Show when={metaHead() || metaTail()}>
            <span data-slot="user-message-meta-wrap">
              <Show when={metaHead()}>
                <span data-slot="user-message-meta" class="text-12-regular text-text-weak cursor-default">
                  {metaHead()}
                </span>
              </Show>
              <Show when={metaHead() && metaTail()}>
                <span data-slot="user-message-meta-sep" class="text-12-regular text-text-weak cursor-default">
                  {"\u00A0\u00B7\u00A0"}
                </span>
              </Show>
              <Show when={metaTail()}>
                <span data-slot="user-message-meta-tail" class="text-12-regular text-text-weak cursor-default">
                  {metaTail()}
                </span>
              </Show>
            </span>
          </Show>
          <Show when={props.actions?.replay}>
            <MessageActionButton
              icon="arrow-up"
              label={i18n.t("ui.message.replayMessage")}
              disabled={!!busy()}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation()
                replay()
              }}
              aria-label={i18n.t("ui.message.replayMessage")}
            />
          </Show>
          <Show when={props.actions?.revert}>
            <MessageActionButton
              icon="reset"
              label={i18n.t("ui.message.revertMessage")}
              disabled={!!busy()}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation()
                revert()
              }}
              aria-label={i18n.t("ui.message.revertMessage")}
            />
          </Show>
          <MessageActionButton
            icon={copied() ? "check" : "copy"}
            label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copyMessage")}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation()
              void handleCopy()
            }}
            aria-label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copyMessage")}
          />
        </div>
      </Show>
    </div>
  )
}

type HighlightSegment = { text: string; type?: "file" | "agent" }

function HighlightedText(props: { text: string; references: FilePart[]; agents: AgentPart[] }) {
  const segments = createMemo(() => {
    const text = props.text

    const allRefs: { start: number; end: number; type: "file" | "agent" }[] = [
      ...props.references
        .filter((r) => r.source?.text?.start !== undefined && r.source?.text?.end !== undefined)
        .map((r) => ({ start: r.source!.text!.start, end: r.source!.text!.end, type: "file" as const })),
      ...props.agents
        .filter((a) => a.source?.start !== undefined && a.source?.end !== undefined)
        .map((a) => ({ start: a.source!.start, end: a.source!.end, type: "agent" as const })),
    ].sort((a, b) => a.start - b.start)

    const result: HighlightSegment[] = []
    let lastIndex = 0

    for (const ref of allRefs) {
      if (ref.start < lastIndex) continue

      if (ref.start > lastIndex) {
        result.push({ text: text.slice(lastIndex, ref.start) })
      }

      result.push({ text: text.slice(ref.start, ref.end), type: ref.type })
      lastIndex = ref.end
    }

    if (lastIndex < text.length) {
      result.push({ text: text.slice(lastIndex) })
    }

    return result
  })

  return <For each={segments()}>{(segment) => <span data-highlight={segment.type}>{segment.text}</span>}</For>
}

export function Part(props: MessagePartProps) {
  const component = createMemo(() => PART_MAPPING[props.part.type])
  return (
    <Show when={component()}>
      <div
        data-slot="message-part-motion"
        ref={(el) => {
          // One-shot enter for newly streamed/completed parts; bulk loads are skipped.
          // Opacity-only — y on streaming rows fights the scroller and looks like flicker.
          animateOutputEnter(el, props.part.id, { y: 0, duration: 0.22 })
        }}
      >
        <Dynamic
          component={component()}
          part={props.part}
          message={props.message}
          hideDetails={props.hideDetails}
          defaultOpen={props.defaultOpen}
          toolOpen={props.toolOpen}
          onToolOpenChange={props.onToolOpenChange}
          deferToolContent={props.deferToolContent}
          virtualizeDiff={props.virtualizeDiff}
          onContentRendered={props.onContentRendered}
          showAssistantCopyPartID={props.showAssistantCopyPartID}
          turnDurationMs={props.turnDurationMs}
          onViewFile={props.onViewFile}
        />
      </div>
    </Show>
  )
}

export interface ToolProps {
  input: Record<string, any>
  metadata: Record<string, any>
  tool: string
  sessionID?: string
  output?: string
  status?: string
  hideDetails?: boolean
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  deferContent?: boolean
  virtualizeDiff?: boolean
  onContentRendered?: () => void
  forceOpen?: boolean
  locked?: boolean
  onViewFile?: (file: string) => void
}

export type ToolComponent = Component<ToolProps>

const state: Record<
  string,
  {
    name: string
    render?: ToolComponent
  }
> = {}

export function registerTool(input: { name: string; render?: ToolComponent }) {
  state[input.name] = input
  return input
}

export function getTool(name: string) {
  return state[name]?.render
}

export const ToolRegistry = {
  register: registerTool,
  render: getTool,
}

// 在 edit/write/apply_patch 折叠态 trigger 上显示的「打开文件」按钮，点击用系统默认编辑器打开源文件
function OpenFileButton(props: { filePath: string; onViewFile?: (file: string) => void }) {
  const i18n = useI18n()
  const label = () => i18n.t("ui.sessionReview.openFile")
  return (
    <Show when={props.onViewFile && props.filePath}>
      <Tooltip value={label()} placement="top" gutter={4}>
        <button
          data-slot="message-part-open-file"
          type="button"
          aria-label={label()}
          onClick={(e) => {
            e.stopPropagation()
            props.onViewFile?.(props.filePath)
          }}
        >
          <Icon name="open-file" size="small" />
        </button>
      </Tooltip>
    </Show>
  )
}

function ToolFileAccordion(props: { path: string; actions?: JSX.Element; children: JSX.Element }) {
  const value = createMemo(() => props.path || "tool-file")

  return (
    <Accordion
      multiple
      data-scope="apply-patch"
      style={{ "--sticky-accordion-offset": "calc(32px + var(--tool-content-gap))" }}
      defaultValue={[value()]}
    >
      <Accordion.Item value={value()}>
        <StickyAccordionHeader>
          <Accordion.Trigger>
            <div data-slot="apply-patch-trigger-content">
              <div data-slot="apply-patch-file-info">
                <FileIcon node={{ path: props.path, type: "file" }} />
                <div data-slot="apply-patch-file-name-container">
                  <Show when={props.path.includes("/")}>
                    <span data-slot="apply-patch-directory">{`\u202A${getDirectory(props.path)}\u202C`}</span>
                  </Show>
                  <span data-slot="apply-patch-filename">{getFilename(props.path)}</span>
                </div>
              </div>
              <div data-slot="apply-patch-trigger-actions">
                {props.actions}
                <Icon name="chevron-grabber-vertical" size="small" />
              </div>
            </div>
          </Accordion.Trigger>
        </StickyAccordionHeader>
        <Accordion.Content>{props.children}</Accordion.Content>
      </Accordion.Item>
    </Accordion>
  )
}

PART_MAPPING["tool"] = function ToolPartDisplay(props) {
  const data = useData()
  const i18n = useI18n()
  const part = () => props.part as ToolPart
  if (part().tool === "todowrite") return null

  const hideQuestion = createMemo(
    () => part().tool === "question" && (part().state.status === "pending" || part().state.status === "running"),
  )

  const emptyInput: Record<string, any> = {}
  const emptyMetadata: Record<string, any> = {}

  const input = () => part().state?.input ?? emptyInput
  // @ts-expect-error
  const partMetadata = () => part().state?.metadata ?? emptyMetadata
  const isTaskTool = createMemo(
    () => part().tool === "task" || part().tool === "task_async" || part().tool === "project_task",
  )
  const taskId = createMemo(() => {
    if (!isTaskTool()) return
    const meta = partMetadata()
    if (typeof meta.sessionId === "string" && meta.sessionId) return meta.sessionId
    if (Array.isArray(meta.taskIDs) && typeof meta.taskIDs[0] === "string") return meta.taskIDs[0]
  })
  const taskDirectory = createMemo(() => {
    if (!isTaskTool()) return undefined
    const meta = partMetadata()
    if (typeof meta.directory === "string" && meta.directory) return meta.directory
    return undefined
  })
  const taskHref = createMemo(() => {
    if (!isTaskTool()) return
    return sessionLink(taskId(), useLocation().pathname, data.sessionHref, taskDirectory())
  })
  const taskSubtitle = createMemo(() => {
    if (!isTaskTool()) return undefined
    const meta = partMetadata()
    const value =
      (typeof input().description === "string" && input().description) ||
      (typeof meta.description === "string" && meta.description) ||
      (typeof meta.title === "string" && meta.title) ||
      undefined
    if (value) return meta.background === true ? `${value} (background)` : value
    if (Array.isArray(meta.tasks) && meta.tasks.length > 1) {
      return `${meta.tasks.length} child sessions${meta.background === true ? " (background)" : ""}`
    }
    return taskId()
  })

  const render = createMemo(() => ToolRegistry.render(part().tool) ?? GenericTool)
  const controlledOpen = () => (props.onToolOpenChange ? (props.toolOpen ?? props.defaultOpen) : undefined)
  const handleToolOpenChange = (open: boolean) => props.onToolOpenChange?.(open)

  return (
    <Show when={!hideQuestion()}>
      <div data-component="tool-part-wrapper" data-timeline-part-id={part().id}>
        <Switch>
          <Match when={part().state.status === "error" && (part().state as any).error}>
            {(error) => {
              const cleaned = error().replace("Error: ", "")
              if (part().tool === "question" && cleaned.includes("dismissed this question")) {
                return (
                  <div style="width: 100%; display: flex; justify-content: flex-end;">
                    <span class="text-13-regular text-text-weak cursor-default">
                      {i18n.t("ui.messagePart.questions.dismissed")}
                    </span>
                  </div>
                )
              }
              return (
                <ToolErrorCard
                  tool={part().tool}
                  error={error()}
                  title={part().tool === "websearch" ? webSearchProviderLabel(partMetadata().provider) : undefined}
                  defaultOpen={props.defaultOpen}
                  open={controlledOpen()}
                  onOpenChange={props.onToolOpenChange ? handleToolOpenChange : undefined}
                  subtitle={taskSubtitle()}
                  href={taskHref()}
                />
              )
            }}
          </Match>
          <Match when={true}>
            <Dynamic
              component={render()}
              input={input()}
              tool={part().tool}
              sessionID={part().sessionID}
              metadata={partMetadata()}
              // @ts-expect-error
              output={part().state.output}
              status={part().state.status}
              hideDetails={props.hideDetails}
              defaultOpen={props.defaultOpen}
              open={controlledOpen()}
              onOpenChange={props.onToolOpenChange ? handleToolOpenChange : undefined}
              deferContent={props.deferToolContent}
              virtualizeDiff={props.virtualizeDiff}
              onContentRendered={props.onContentRendered}
              onViewFile={props.onViewFile}
            />
          </Match>
        </Switch>
      </div>
    </Show>
  )
}

export function MessageDivider(props: { label: string }) {
  return (
    <div data-component="compaction-part">
      <div data-slot="compaction-part-divider">
        <span data-slot="compaction-part-line" />
        <span data-slot="compaction-part-label" class="text-12-regular text-text-weak">
          {props.label}
        </span>
        <span data-slot="compaction-part-line" />
      </div>
    </div>
  )
}

PART_MAPPING["compaction"] = function CompactionPartDisplay() {
  const i18n = useI18n()
  return <MessageDivider label={i18n.t("ui.messagePart.compaction")} />
}

type ChunkSummaryBlock = {
  id: string
  inputs: string[]
  summary: string
  folded?: number
}

type ParsedChunkSummary = {
  strategy?: string
  chunks: ChunkSummaryBlock[]
}

function extractTagged(text: string, tag: string) {
  const re = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "g")
  const items: { attrs: string; body: string }[] = []
  for (const match of text.matchAll(re)) {
    items.push({ attrs: match[1] ?? "", body: (match[2] ?? "").trim() })
  }
  return items
}

function attrValue(attrs: string, name: string) {
  const match = attrs.match(new RegExp(`${name}="([^"]*)"`))
  return match?.[1]
}

function parseUserMessages(body: string) {
  const tagged = extractTagged(body, "user-message")
  if (tagged.length > 0) return tagged.map((item) => item.body).filter(Boolean)
  return body.trim() ? [body.trim()] : []
}

function parseChunkSummaryText(text: string): ParsedChunkSummary | undefined {
  if (!text.includes("<conversation-checkpoint") && !text.includes("<chunk-input") && !text.includes("<chunk-summary")) {
    return
  }
  const checkpoint = extractTagged(text, "conversation-checkpoint")[0]
  const strategy = checkpoint ? attrValue(checkpoint.attrs, "strategy") : undefined
  const inputs = extractTagged(text, "chunk-input")
  const summaries = extractTagged(text, "chunk-summary")
  const byID = new Map<string, ChunkSummaryBlock>()
  for (const item of inputs) {
    const id = attrValue(item.attrs, "id") ?? "unknown"
    const current = byID.get(id) ?? { id, inputs: [], summary: "" }
    current.inputs.push(...parseUserMessages(item.body))
    byID.set(id, current)
  }
  for (const item of summaries) {
    const id = attrValue(item.attrs, "id") ?? "unknown"
    const current = byID.get(id) ?? { id, inputs: [], summary: "" }
    current.summary = item.body
    const folded = attrValue(item.attrs, "folded-messages")
    if (folded) current.folded = Number(folded)
    byID.set(id, current)
  }
  const chunks = [...byID.values()]
  if (chunks.length === 0 && !checkpoint) return
  return { strategy, chunks }
}

function previewText(value: string, max = 120) {
  const one = value.replace(/\s+/g, " ").trim()
  if (one.length <= max) return one
  return one.slice(0, max - 1) + "…"
}

function ChunkSummaryDisplay(props: { text: string; parsed: ParsedChunkSummary; partID: string }) {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)
  const [expanded, setExpanded] = createSignal<string[]>([])
  const count = createMemo(() => props.parsed.chunks.length)
  const label = createMemo(() => {
    if (count() === 0) return i18n.t("ui.messagePart.compaction")
    return i18n.t(count() === 1 ? "ui.chunkSummary.title.one" : "ui.chunkSummary.title.other", {
      count: String(count()),
    })
  })
  const toggleChunk = (id: string) => {
    setExpanded((list) => (list.includes(id) ? list.filter((item) => item !== id) : [...list, id]))
  }

  return (
    <div data-component="chunk-summary" data-timeline-part-id={props.partID}>
      <button
        type="button"
        data-slot="chunk-summary-trigger"
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
      >
        <span data-slot="chunk-summary-line" />
        <span data-slot="chunk-summary-label">
          <Icon name="archive" size="small" />
          <span>{label()}</span>
          <Icon name={open() ? "chevron-down" : "chevron-right"} size="small" />
        </span>
        <span data-slot="chunk-summary-line" />
      </button>
      <Show when={open()}>
        <div data-slot="chunk-summary-body">
          <div data-slot="chunk-summary-note">{i18n.t("ui.chunkSummary.note")}</div>
          <Show
            when={count() > 0}
            fallback={
              <div data-slot="chunk-summary-empty">
                <Markdown text={props.text} cacheKey={props.partID} streaming={false} />
              </div>
            }
          >
            <div data-slot="chunk-summary-list">
              <For each={props.parsed.chunks}>
                {(chunk) => {
                  const isOpen = () => expanded().includes(chunk.id)
                  const inputPreview = () => previewText(chunk.inputs.join(" · ") || i18n.t("ui.chunkSummary.noInput"))
                  const summaryPreview = () =>
                    previewText(chunk.summary || i18n.t("ui.chunkSummary.noSummary"))
                  return (
                    <div data-slot="chunk-card" data-open={isOpen() ? "true" : undefined}>
                      <button
                        type="button"
                        data-slot="chunk-card-trigger"
                        aria-expanded={isOpen()}
                        onClick={() => toggleChunk(chunk.id)}
                      >
                        <span data-slot="chunk-card-id">{chunk.id}</span>
                        <Show when={chunk.folded != null}>
                          <span data-slot="chunk-card-meta">
                            {i18n.t("ui.chunkSummary.folded", { count: String(chunk.folded!) })}
                          </span>
                        </Show>
                        <span data-slot="chunk-card-preview">{inputPreview()}</span>
                        <Icon name={isOpen() ? "chevron-down" : "chevron-right"} size="small" />
                      </button>
                      <Show when={isOpen()}>
                        <div data-slot="chunk-card-body">
                          <Show when={chunk.inputs.length > 0}>
                            <div data-slot="chunk-section">
                              <div data-slot="chunk-section-label">{i18n.t("ui.chunkSummary.user")}</div>
                              <div data-slot="chunk-section-list">
                                <For each={chunk.inputs}>
                                  {(input) => (
                                    <div data-slot="chunk-user">
                                      <Markdown text={input} streaming={false} />
                                    </div>
                                  )}
                                </For>
                              </div>
                            </div>
                          </Show>
                          <Show when={chunk.summary}>
                            <div data-slot="chunk-section">
                              <div data-slot="chunk-section-label">{i18n.t("ui.chunkSummary.assistant")}</div>
                              <div data-slot="chunk-assistant">
                                <Markdown text={chunk.summary} streaming={false} />
                              </div>
                            </div>
                          </Show>
                          <Show when={!chunk.summary}>
                            <div data-slot="chunk-section-empty">{summaryPreview()}</div>
                          </Show>
                        </div>
                      </Show>
                    </div>
                  )
                }}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}

PART_MAPPING["text"] = function TextPartDisplay(props) {
  const data = useData()
  const i18n = useI18n()
  const numfmt = createMemo(() => new Intl.NumberFormat(i18n.locale()))
  const part = () => props.part as TextPart
  const interrupted = createMemo(
    () =>
      props.message.role === "assistant" && (props.message as AssistantMessage).error?.name === "MessageAbortedError",
  )

  const model = createMemo(() => {
    if (props.message.role !== "assistant") return ""
    const message = props.message as AssistantMessage
    const match = data.store.provider?.all?.get(message.providerID)
    return match?.models?.[message.modelID]?.name ?? message.modelID
  })

  const duration = createMemo(() => {
    if (props.message.role !== "assistant") return ""
    const message = props.message as AssistantMessage
    const completed = message.time.completed
    const ms =
      typeof props.turnDurationMs === "number"
        ? props.turnDurationMs
        : typeof completed === "number"
          ? completed - message.time.created
          : -1
    if (!(ms >= 0)) return ""
    const total = Math.round(ms / 1000)
    if (total < 60) return i18n.t("ui.message.duration.seconds", { count: numfmt().format(total) })
    const minutes = Math.floor(total / 60)
    const seconds = total % 60
    return i18n.t("ui.message.duration.minutesSeconds", {
      minutes: numfmt().format(minutes),
      seconds: numfmt().format(seconds),
    })
  })

  const meta = createMemo(() => {
    if (props.message.role !== "assistant") return ""
    const message = props.message as AssistantMessage
    const items = [
      message.agent && message.agent !== "compaction"
        ? message.agent[0]?.toUpperCase() + message.agent.slice(1)
        : "",
      model(),
      message.variant ?? "",
      duration(),
      interrupted() ? i18n.t("ui.message.interrupted") : "",
    ]
    return items.filter((x) => !!x).join(" \u00B7 ")
  })

  const text = () => readPartText(data.store.part_text_accum_delta, part())
  const chunkSummary = createMemo(() => {
    if (props.message.role !== "assistant") return
    const message = props.message as AssistantMessage
    if (!(message.summary === true || message.mode === "compaction" || message.agent === "compaction")) return
    return parseChunkSummaryText(text())
  })
  const isLastTextPart = createMemo(() =>
    isLastTextualPart(data.store.part?.[props.message.id] ?? [], part().id, "text"),
  )
  const streaming = createMemo(
    () =>
      isLastTextPart() &&
      props.message.role === "assistant" &&
      typeof (props.message as AssistantMessage).time.completed !== "number" &&
      part().time?.end === undefined,
  )
  const showCopy = createMemo(() => {
    if (chunkSummary()) return false
    if (props.message.role !== "assistant") return isLastTextPart()
    if (props.showAssistantCopyPartID === null) return false
    if (typeof props.showAssistantCopyPartID === "string") return props.showAssistantCopyPartID === part().id
    return isLastTextPart()
  })
  const [copied, setCopied] = createSignal(false)

  const handleCopy = async () => {
    const content = text()
    if (!content) return
    if (await writeClipboard(content)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <Show when={text()}>
      <Show
        when={chunkSummary()}
        fallback={
          <div data-component="text-part" data-timeline-part-id={part().id}>
            <div data-slot="text-part-body">
              <Show when={streaming()} fallback={<Markdown text={text()} cacheKey={part().id} streaming={false} />}>
                <PacedMarkdown text={text()} cacheKey={part().id} streaming={streaming()} />
              </Show>
            </div>
            <Show when={showCopy()}>
              <div data-slot="text-part-copy-wrapper" data-interrupted={interrupted() ? "" : undefined}>
                <MessageActionButton
                  icon={copied() ? "check" : "copy"}
                  label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copyResponse")}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={handleCopy}
                  aria-label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copyResponse")}
                />
                <Show when={meta()}>
                  <span data-slot="text-part-meta" class="text-12-regular text-text-weak cursor-default">
                    {meta()}
                  </span>
                </Show>
              </div>
            </Show>
          </div>
        }
      >
        {(parsed) => <ChunkSummaryDisplay text={text()} parsed={parsed()} partID={part().id} />}
      </Show>
    </Show>
  )
}

PART_MAPPING["reasoning"] = function ReasoningPartDisplay(props) {
  const data = useData()
  const part = () => props.part as ReasoningPart
  const isLastReasoningPart = createMemo(() =>
    isLastTextualPart(data.store.part?.[props.message.id] ?? [], part().id, "reasoning"),
  )
  const streaming = createMemo(
    () =>
      isLastReasoningPart() &&
      props.message.role === "assistant" &&
      typeof (props.message as AssistantMessage).time.completed !== "number" &&
      part().time.end === undefined,
  )
  const text = () => readPartText(data.store.part_text_accum_delta, part())

  return (
    <Show when={text()}>
      <div data-component="reasoning-part" data-timeline-part-id={part().id}>
        <Show when={streaming()} fallback={<Markdown text={text()} cacheKey={part().id} streaming={false} />}>
          <PacedMarkdown text={text()} cacheKey={part().id} streaming={streaming()} />
        </Show>
      </div>
    </Show>
  )
}

ToolRegistry.register({
  name: "goal_update",
  render(props) {
    const i18n = useI18n()
    const pending = createMemo(() => props.status === "pending" || props.status === "running")
    const failed = createMemo(
      () => props.status === "completed" && props.output?.startsWith("Failed to update goal status:") === true,
    )
    const blocked = createMemo(() => props.input.status === "blocked")
    const variant = createMemo(() => {
      if (failed()) return "error" as const
      if (blocked()) return "warning" as const
      if (!pending()) return "success" as const
      return "normal" as const
    })
    const title = createMemo(() => {
      if (pending()) return i18n.t("ui.goalTool.update.running")
      if (failed()) return i18n.t("ui.goalTool.update.failed")
      if (blocked()) return i18n.t("ui.goalTool.update.blocked")
      return i18n.t("ui.goalTool.update.complete")
    })
    const description = createMemo(() => {
      if (failed() && props.output?.includes("evidence callIDs invalid")) {
        return i18n.t("ui.goalTool.update.invalidEvidence")
      }
      if (failed()) return props.output ?? i18n.t("ui.goalTool.update.failedDescription")
      if (blocked()) return i18n.t("ui.goalTool.update.blockedDescription")
      if (!pending()) return i18n.t("ui.goalTool.update.completeDescription")
    })
    const evidence = createMemo(() => {
      const value = props.input.evidenceCallIDs
      if (!Array.isArray(value)) return []
      return value.filter((item): item is string => typeof item === "string")
    })

    return (
      <Card data-component="goal-update-tool" variant={variant()}>
        <CardTitle variant={variant()} icon={pending() ? false : undefined}>
          <Show when={pending()}>
            <Spinner class="size-[15px]" />
          </Show>
          <span>{title()}</span>
        </CardTitle>
        <Show when={description()}>
          <CardDescription>{description()}</CardDescription>
        </Show>
        <Show when={!failed() && evidence().length > 0}>
          <div data-slot="goal-tool-evidence">
            <span>{i18n.t("ui.goalTool.evidence", { count: evidence().length })}</span>
          </div>
        </Show>
      </Card>
    )
  },
})

ToolRegistry.register({
  name: "read",
  render(props) {
    const data = useData()
    const i18n = useI18n()
    const args: string[] = []
    if (props.input.offset) args.push("offset=" + props.input.offset)
    if (props.input.limit) args.push("limit=" + props.input.limit)
    const loaded = createMemo(() => {
      if (props.status !== "completed") return []
      const value = props.metadata.loaded
      if (!value || !Array.isArray(value)) return []
      return value.filter((p): p is string => typeof p === "string")
    })
    return (
      <>
        <BasicTool
          {...props}
          icon="glasses"
          trigger={{
            title: i18n.t("ui.tool.read"),
            subtitle: props.input.filePath ? getFilename(props.input.filePath) : "",
            args,
          }}
        />
        <For each={loaded()}>
          {(filepath) => (
            <div data-component="tool-loaded-file">
              <Icon name="enter" size="small" />
              <span>
                {i18n.t("ui.tool.loaded")} {relativizeProjectPath(filepath, data.directory)}
              </span>
            </div>
          )}
        </For>
      </>
    )
  },
})

function ListDirToolRender(props: ToolProps) {
  const i18n = useI18n()
  const directory = (typeof props.input.path === "string" && props.input.path) || "/"
  return (
    <BasicTool
      {...props}
      icon="bullet-list"
      trigger={{ title: i18n.t("ui.tool.list"), subtitle: getDirectory(directory) }}
    >
      <Show when={props.output}>
        <div
          data-component="tool-output"
          data-scrollable
          tabIndex={0}
          role="region"
          aria-label={i18n.t("ui.scrollView.ariaLabel")}
        >
          <Markdown text={props.output!} />
        </div>
      </Show>
    </BasicTool>
  )
}

ToolRegistry.register({
  name: "list_dir",
  render: ListDirToolRender,
})

ToolRegistry.register({
  name: "glob",
  render(props) {
    const i18n = useI18n()
    return (
      <BasicTool
        {...props}
        icon="magnifying-glass-menu"
        trigger={{
          title: i18n.t("ui.tool.glob"),
          subtitle: getDirectory(props.input.path || "/"),
          args: props.input.pattern ? ["pattern=" + props.input.pattern] : [],
        }}
      >
        <Show when={props.output}>
          <div
            data-component="tool-output"
            data-scrollable
            tabIndex={0}
            role="region"
            aria-label={i18n.t("ui.scrollView.ariaLabel")}
          >
            <Markdown text={props.output!} />
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "grep",
  render(props) {
    const i18n = useI18n()
    const args: string[] = []
    if (props.input.pattern) args.push("pattern=" + props.input.pattern)
    if (props.input.include) args.push("include=" + props.input.include)
    return (
      <BasicTool
        {...props}
        icon="magnifying-glass-menu"
        trigger={{
          title: i18n.t("ui.tool.grep"),
          subtitle: getDirectory(props.input.path || "/"),
          args,
        }}
      >
        <Show when={props.output}>
          <div
            data-component="tool-output"
            data-scrollable
            tabIndex={0}
            role="region"
            aria-label={i18n.t("ui.scrollView.ariaLabel")}
          >
            <Markdown text={props.output!} />
          </div>
        </Show>
      </BasicTool>
    )
  },
})

const HISTORY_SOURCE_RE =
  /^(USER|ASSISTANT|ASSISTANT_TOOL|TOOL_OUTPUT|TOOL_ERROR|SHELL)$/

type HistorySource = "USER" | "ASSISTANT" | "ASSISTANT_TOOL" | "TOOL_OUTPUT" | "TOOL_ERROR" | "SHELL"

type HistoryLine = {
  line?: number
  source?: HistorySource
  text: string
  hit?: boolean
}

type HistoryGrepHit = {
  chunk: string
  sequence?: number
  source?: HistorySource
  line?: number
  text: string
  context: HistoryLine[]
}

function historySourceLabel(source: HistorySource | undefined, i18n: ReturnType<typeof useI18n>) {
  if (!source) return ""
  if (source === "USER") return i18n.t("ui.historyTool.source.user")
  if (source === "ASSISTANT") return i18n.t("ui.historyTool.source.assistant")
  if (source === "ASSISTANT_TOOL") return i18n.t("ui.historyTool.source.tool")
  if (source === "TOOL_OUTPUT") return i18n.t("ui.historyTool.source.output")
  if (source === "TOOL_ERROR") return i18n.t("ui.historyTool.source.error")
  return i18n.t("ui.historyTool.source.shell")
}

function parseHistoryLine(raw: string): HistoryLine {
  const trimmed = raw.replace(/^\s+/, "")
  const match = trimmed.match(/^(\d+)\s+([A-Z_]+):\s?(.*)$/)
  if (!match) return { text: trimmed }
  const source = match[2]!
  if (!HISTORY_SOURCE_RE.test(source)) return { text: trimmed }
  return {
    line: Number(match[1]),
    source: source as HistorySource,
    text: match[3] ?? "",
  }
}

function parseHistoryListOutput(output: string | undefined): HistoryLine[] | undefined {
  if (!output) return
  const lines = output.split("\n").flatMap((row) => {
    const parsed = parseHistoryLine(row)
    if (!parsed.source && parsed.text.trim() === "") return []
    return [parsed]
  })
  return lines.length > 0 ? lines : undefined
}

function parseHistoryGrepOutput(output: string | undefined): HistoryGrepHit[] | undefined {
  if (!output) return
  const blocks = output.split(/\n\n+/).map((block) => block.trim()).filter(Boolean)
  const hits: HistoryGrepHit[] = []
  for (const block of blocks) {
    const rows = block.split("\n")
    const header = rows[0]?.match(/^chunk\s+(\S+)(?:\s+\(sequence\s+(\d+)\))?\s+([A-Z_]+)?\s+line\s+(\d+):?$/)
    if (!header) continue
    const source = header[3] && HISTORY_SOURCE_RE.test(header[3]) ? (header[3] as HistorySource) : undefined
    const hitText = (rows[1] ?? "").replace(/^\s+/, "")
    const contextStart = rows.findIndex((row) => row.trim() === "context:")
    const context =
      contextStart >= 0
        ? rows.slice(contextStart + 1).map((row) => parseHistoryLine(row))
        : []
    hits.push({
      chunk: header[1]!,
      sequence: header[2] ? Number(header[2]) : undefined,
      source,
      line: header[4] ? Number(header[4]) : undefined,
      text: hitText,
      context,
    })
  }
  return hits.length > 0 ? hits : undefined
}

function HistoryTranscriptLine(props: { entry: HistoryLine; i18n: ReturnType<typeof useI18n> }) {
  return (
    <div
      data-slot="history-line"
      data-source={props.entry.source?.toLowerCase()}
      data-hit={props.entry.hit ? "true" : undefined}
    >
      <span data-slot="history-line-no">{props.entry.line ?? ""}</span>
      <span data-slot="history-source">{historySourceLabel(props.entry.source, props.i18n)}</span>
      <span data-slot="history-text">{props.entry.text}</span>
    </div>
  )
}

function HistoryToolOutput(props: {
  text: string
  ariaLabel: string
  children: JSX.Element
}) {
  const i18n = useI18n()
  const [copied, setCopied] = createSignal(false)
  const handleCopy = async () => {
    if (!props.text) return
    if (await writeClipboard(props.text)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div data-component="history-output">
      <div data-slot="history-copy">
        <TooltipV2 value={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copy")} placement="top">
          <IconButtonV2
            icon={<IconV2 name={copied() ? "check" : "outline-copy"} size="small" />}
            size="normal"
            variant="ghost-muted"
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleCopy}
            aria-label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copy")}
          />
        </TooltipV2>
      </div>
      <div data-slot="history-scroll" data-scrollable tabIndex={0} role="region" aria-label={props.ariaLabel}>
        {props.children}
      </div>
    </div>
  )
}

ToolRegistry.register({
  name: "history_grep",
  render(props) {
    const i18n = useI18n()
    const pending = createMemo(() => props.status === "pending" || props.status === "running")
    const matches = createMemo(() => {
      const value = props.metadata.matches
      return typeof value === "number" ? value : undefined
    })
    const hits = createMemo(() => parseHistoryGrepOutput(props.output))
    const args = createMemo(() => {
      const list: string[] = []
      if (props.input.chunk_id) list.push("chunk=" + props.input.chunk_id)
      if (props.input.case_sensitive) list.push("case=true")
      if (props.input.head_limit != null) list.push("limit=" + props.input.head_limit)
      if (!pending() && matches() != null) list.push(i18n.t("ui.historyTool.matches", { count: matches()! }))
      return list
    })
    const pattern = createMemo(() => (typeof props.input.pattern === "string" ? props.input.pattern : ""))
    const empty = createMemo(() => !pending() && !!props.output && !hits())

    return (
      <BasicTool
        {...props}
        icon="archive"
        trigger={
          <div data-slot="basic-tool-tool-info-structured">
            <div data-slot="basic-tool-tool-info-main">
              <span data-slot="basic-tool-tool-title">
                <ToolStatusTitle
                  active={pending()}
                  activeText={i18n.t("ui.historyTool.grep.running")}
                  doneText={i18n.t("ui.historyTool.grep.done")}
                  split={false}
                />
              </span>
              <Show when={!pending() && pattern()}>
                <span data-slot="basic-tool-tool-subtitle">{pattern()}</span>
              </Show>
              <Show when={!pending() && args().length}>
                <For each={args()}>{(arg) => <span data-slot="basic-tool-tool-arg">{arg}</span>}</For>
              </Show>
            </div>
          </div>
        }
      >
        <Show when={hits()}>
          {(parsed) => (
            <HistoryToolOutput text={props.output!} ariaLabel={i18n.t("ui.scrollView.ariaLabel")}>
              <div data-slot="history-hits">
                <For each={parsed()}>
                  {(hit) => (
                    <div data-slot="history-hit">
                      <div data-slot="history-hit-header">
                        <span data-slot="history-chunk">{hit.chunk}</span>
                        <Show when={hit.sequence != null}>
                          <span data-slot="history-meta">
                            {i18n.t("ui.historyTool.sequence", { sequence: hit.sequence! })}
                          </span>
                        </Show>
                        <Show when={hit.line != null}>
                          <span data-slot="history-meta">
                            {i18n.t("ui.historyTool.line", { line: hit.line! })}
                          </span>
                        </Show>
                        <Show when={hit.source}>
                          <span data-slot="history-source">{historySourceLabel(hit.source, i18n)}</span>
                        </Show>
                      </div>
                      <Show
                        when={hit.context.length > 0}
                        fallback={
                          <HistoryTranscriptLine
                            entry={{ text: hit.text, source: hit.source, line: hit.line, hit: true }}
                            i18n={i18n}
                          />
                        }
                      >
                        <div data-slot="history-context">
                          <For each={hit.context}>
                            {(entry) => (
                              <HistoryTranscriptLine
                                entry={{ ...entry, hit: entry.line === hit.line }}
                                i18n={i18n}
                              />
                            )}
                          </For>
                        </div>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </HistoryToolOutput>
          )}
        </Show>
        <Show when={empty()}>
          <HistoryToolOutput text={props.output!} ariaLabel={i18n.t("ui.scrollView.ariaLabel")}>
            <div data-slot="history-empty">{props.output}</div>
          </HistoryToolOutput>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "history_list",
  render(props) {
    const i18n = useI18n()
    const pending = createMemo(() => props.status === "pending" || props.status === "running")
    const lines = createMemo(() => {
      const value = props.metadata.lines
      return typeof value === "number" ? value : undefined
    })
    const total = createMemo(() => {
      const value = props.metadata.total
      return typeof value === "number" ? value : undefined
    })
    const entries = createMemo(() => parseHistoryListOutput(props.output))
    const args = createMemo(() => {
      const list: string[] = []
      if (props.input.offset != null) list.push("offset=" + props.input.offset)
      if (props.input.limit != null) list.push("limit=" + props.input.limit)
      if (!pending() && lines() != null && total() != null) {
        list.push(i18n.t("ui.historyTool.range", { lines: lines()!, total: total()! }))
      } else if (!pending() && lines() != null) {
        list.push(i18n.t("ui.historyTool.lines", { count: lines()! }))
      }
      return list
    })
    const chunk = createMemo(() => (typeof props.input.chunk_id === "string" ? props.input.chunk_id : ""))
    const empty = createMemo(() => !pending() && !!props.output && !entries())

    return (
      <BasicTool
        {...props}
        icon="archive"
        trigger={
          <div data-slot="basic-tool-tool-info-structured">
            <div data-slot="basic-tool-tool-info-main">
              <span data-slot="basic-tool-tool-title">
                <ToolStatusTitle
                  active={pending()}
                  activeText={i18n.t("ui.historyTool.list.running")}
                  doneText={i18n.t("ui.historyTool.list.done")}
                  split={false}
                />
              </span>
              <Show when={!pending() && chunk()}>
                <span data-slot="basic-tool-tool-subtitle">{chunk()}</span>
              </Show>
              <Show when={!pending() && args().length}>
                <For each={args()}>{(arg) => <span data-slot="basic-tool-tool-arg">{arg}</span>}</For>
              </Show>
            </div>
          </div>
        }
      >
        <Show when={entries()}>
          {(parsed) => (
            <HistoryToolOutput text={props.output!} ariaLabel={i18n.t("ui.scrollView.ariaLabel")}>
              <div data-slot="history-transcript">
                <For each={parsed()}>{(entry) => <HistoryTranscriptLine entry={entry} i18n={i18n} />}</For>
              </div>
            </HistoryToolOutput>
          )}
        </Show>
        <Show when={empty()}>
          <HistoryToolOutput text={props.output!} ariaLabel={i18n.t("ui.scrollView.ariaLabel")}>
            <div data-slot="history-empty">{props.output}</div>
          </HistoryToolOutput>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "webfetch",
  render(props) {
    const i18n = useI18n()
    const pending = createMemo(() => props.status === "pending" || props.status === "running")
    const url = createMemo(() => {
      const value = props.input.url
      if (typeof value !== "string") return ""
      return value
    })
    return (
      <BasicTool
        {...props}
        hideDetails
        icon="window-cursor"
        trigger={
          <div data-slot="basic-tool-tool-info-structured">
            <div data-slot="basic-tool-tool-info-main">
              <span data-slot="basic-tool-tool-title">
                <TextShimmer text={i18n.t("ui.tool.webfetch")} active={pending()} />
              </span>
              <Show when={!pending() && url()}>
                <a
                  data-slot="basic-tool-tool-subtitle"
                  class="clickable subagent-link"
                  href={url()}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => event.stopPropagation()}
                >
                  {url()}
                </a>
              </Show>
            </div>
            <Show when={!pending() && url()}>
              <div data-component="tool-action">
                <Icon name="square-arrow-top-right" size="small" />
              </div>
            </Show>
          </div>
        }
      />
    )
  },
})

ToolRegistry.register({
  name: "websearch",
  render(props) {
    const query = createMemo(() => {
      const value = props.input.query
      if (typeof value !== "string") return ""
      return value
    })
    const title = createMemo(() => webSearchProviderLabel(props.metadata.provider))

    return (
      <BasicTool
        {...props}
        icon="window-cursor"
        trigger={{
          title: title(),
          subtitle: query(),
          subtitleClass: "exa-tool-query",
        }}
      >
        <ExaOutput output={props.output} />
      </BasicTool>
    )
  },
})

function taskCards(input: Record<string, any>, metadata: Record<string, any>) {
  // project_task 通过 metadata 携带目标项目目录。
  const directory = typeof metadata.directory === "string" ? metadata.directory : undefined
  const metaTasks = Array.isArray(metadata.tasks) ? metadata.tasks : undefined
  if (metaTasks && metaTasks.length > 0) {
    return metaTasks.flatMap((item, index) => {
      if (!item || typeof item !== "object") return []
      const row = item as Record<string, unknown>
      const sessionId =
        (typeof row.sessionId === "string" && row.sessionId) ||
        (typeof row.sessionID === "string" && row.sessionID) ||
        (Array.isArray(metadata.taskIDs) && typeof metadata.taskIDs[index] === "string"
          ? metadata.taskIDs[index]
          : undefined)
      return [
        {
          sessionId,
          agent:
            (typeof row.agent === "string" && row.agent) ||
            (typeof row.subagent_type === "string" && row.subagent_type) ||
            undefined,
          description:
            (typeof row.title === "string" && row.title) ||
            (typeof row.description === "string" && row.description) ||
            undefined,
          directory,
        },
      ]
    })
  }

  const inputTasks = Array.isArray(input.tasks) ? input.tasks : undefined
  if (inputTasks && inputTasks.length > 0) {
    return inputTasks.flatMap((item, index) => {
      if (!item || typeof item !== "object") return []
      const row = item as Record<string, unknown>
      const sessionId =
        (typeof metadata.sessionId === "string" && inputTasks.length === 1 && metadata.sessionId) ||
        (Array.isArray(metadata.taskIDs) && typeof metadata.taskIDs[index] === "string"
          ? metadata.taskIDs[index]
          : undefined)
      return [
        {
          sessionId,
          agent:
            (typeof row.subagent_type === "string" && row.subagent_type) ||
            (typeof row.agent === "string" && row.agent) ||
            undefined,
          description:
            (typeof row.description === "string" && row.description) ||
            (typeof row.title === "string" && row.title) ||
            undefined,
          directory,
        },
      ]
    })
  }

  return [
    {
      sessionId: typeof metadata.sessionId === "string" ? metadata.sessionId : undefined,
      agent:
        (typeof input.subagent_type === "string" && input.subagent_type) ||
        (typeof input.agent === "string" && input.agent) ||
        (typeof metadata.agent === "string" && metadata.agent) ||
        undefined,
      description:
        (typeof input.description === "string" && input.description) ||
        (typeof metadata.description === "string" && metadata.description) ||
        (typeof metadata.title === "string" && metadata.title) ||
        undefined,
      directory,
    },
  ]
}

function taskFollowupDescription(value: string | undefined) {
  if (!value) return value
  return value.replace(/^(follow-up|followup|接力|续写)\s*[:：-]\s*/i, "").trim() || value
}

function TaskCard(props: {
  status?: string
  agent?: string
  description?: string
  sessionId?: string
  background?: boolean
  followup?: boolean
  fallbackInput?: Record<string, any>
  directory?: string
}) {
  const data = useData()
  const i18n = useI18n()
  const location = useLocation()
  const running = createMemo(() => props.status === "pending" || props.status === "running")
  const childSessionId = createMemo(() => {
    if (props.sessionId) return props.sessionId
    if (!props.fallbackInput) return
    return taskSession(props.fallbackInput, location.pathname, data.store.session, data.store.agent)
  })
  const agent = createMemo(() => taskAgent(props.agent, data.store.agent))
  const title = createMemo(() => agent().name ?? i18n.t("ui.tool.agent.default"))
  const tone = createMemo(() => agent().color)
  const v2Tone = createMemo(() => agent().v2Color)
  const childRunning = createMemo(() => {
    const id = childSessionId()
    if (id && data.store.session_status[id]) return data.store.session_status[id].type !== "idle"
    return running()
  })
  const activity = createMemo(() => {
    const id = childSessionId()
    if (!id) return
    const messages = data.store.message[id] ?? []
    const part = messages
      .flatMap((message) => data.store.part[message.id] ?? [])
      .findLast((part) => {
        if (part.type === "tool") return true
        if (part.type !== "text" && part.type !== "reasoning") return false
        return !!readPartText(data.store.part_text_accum_delta, part)
      })
    if (!part) return
    if (part.type !== "tool") {
      const value = stripAnsi(readPartText(data.store.part_text_accum_delta, part)).replace(/\s+/g, " ").trim()
      return {
        key: part.id,
        text: value.slice(-240),
      }
    }
    const state = part.state
    const detail =
      state.status === "completed"
        ? state.output
        : state.status === "error"
          ? state.error
          : state.status === "running"
            ? state.title
            : undefined
    const value = typeof detail === "string" ? stripAnsi(detail).replace(/\s+/g, " ").trim() : ""
    return {
      key: `${part.id}:${state.status}`,
      text: value ? `${part.tool} · ${value.slice(-240)}` : part.tool,
    }
  })
  const activityKey = createMemo(() => activity()?.key)
  const subtitle = createMemo(() => {
    const raw = props.followup ? taskFollowupDescription(props.description) : props.description
    const value = raw || childSessionId()
    if (!value) return props.background ? "background" : value
    if (props.background) return `${value} (background)`
    return value
  })
  const href = createMemo(() => sessionLink(childSessionId(), location.pathname, data.sessionHref, props.directory))
  const clickable = createMemo(() => !!(childSessionId() && (data.navigateToSession || href())))

  const openSession = () => {
    const id = childSessionId()
    if (!id) return
    if (data.navigateToSession) {
      data.navigateToSession(id, props.directory)
      return
    }
    const value = href()
    if (value) window.location.assign(value)
  }

  const navigate = (event: MouseEvent) => {
    if (!data.navigateToSession) return
    if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    event.preventDefault()
    openSession()
  }
  const navigateKey = (event: KeyboardEvent) => {
    if (!clickable() || href()) return
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    openSession()
  }

  const trigger = () => (
    <div
      data-component="task-tool-card"
      data-kind={props.followup ? "followup" : "launch"}
      style={{
        "--task-agent-color": v2Tone(),
        "--task-agent-legacy-color": tone(),
      }}
    >
      <div data-component="task-tool-surface">
        <div data-slot="basic-tool-tool-info-structured">
          <div data-slot="basic-tool-tool-info-main">
            <Show
              when={childRunning()}
              fallback={
                <span data-component="task-tool-icon">
                  <Icon name={props.followup ? "enter" : "subagent"} size="small" />
                </span>
              }
            >
              <span data-component="task-tool-spinner" style={{ color: tone() ?? "var(--icon-interactive-base)" }}>
                <Spinner class="size-[15px]" />
              </span>
            </Show>
            <span data-component="task-tool-copy">
              <span data-component="task-tool-heading">
                <span data-component="task-tool-title">{title()}</span>
                <Show when={subtitle()}>
                  <span data-slot="basic-tool-tool-subtitle">{subtitle()}</span>
                </Show>
              </span>
              <Show when={activityKey()} keyed>
                {() => (
                  <span data-component="task-tool-activity">
                    <ShellSubmessage text={activity()?.text ?? ""} animate />
                  </span>
                )}
              </Show>
            </span>
          </div>
        </div>
      </div>
      <Show when={clickable()}>
        <div data-component="task-tool-action">
          <Icon name="square-arrow-top-right" size="small" />
        </div>
      </Show>
    </div>
  )

  return (
    <BasicTool
      icon="task"
      status={props.status}
      trigger={trigger()}
      hideDetails
      triggerAsLink
      triggerHref={href()}
      clickable={clickable()}
      onTriggerClick={navigate}
      onTriggerKeyDown={navigateKey}
    />
  )
}

function TaskToolRender(props: ToolProps) {
  const cards = createMemo(() => taskCards(props.input, props.metadata))
  const background = createMemo(() => props.metadata.background === true)
  const single = createMemo(() => cards().length === 1)

  return (
    <div data-component="task-tool-list">
      <For each={cards()}>
        {(card) => (
          <TaskCard
            status={props.status}
            agent={card.agent}
            description={card.description}
            sessionId={card.sessionId}
            directory={card.directory}
            background={background()}
            fallbackInput={
              single()
                ? {
                    ...props.input,
                    description: card.description ?? props.input.description,
                    subagent_type: card.agent ?? props.input.subagent_type,
                  }
                : undefined
            }
          />
        )}
      </For>
    </div>
  )
}

ToolRegistry.register({
  name: "task",
  render(props) {
    return <TaskToolRender {...props} />
  },
})

// Alias used by models / plugins that call task_async instead of task.
ToolRegistry.register({
  name: "task_async",
  render(props) {
    return <TaskToolRender {...props} />
  },
})

// 跨项目委派复用任务卡，并由 metadata.directory 决定子会话路由。
ToolRegistry.register({
  name: "project_task",
  render(props) {
    return <TaskToolRender {...props} />
  },
})

function taskManageTitleKey(tool: string) {
  if (tool === "task_async_status") return "ui.tool.task.status"
  if (tool === "task_async_wait") return "ui.tool.task.wait"
  if (tool === "task_async_abort") return "ui.tool.task.abort"
  return "ui.tool.task.followup"
}

function TaskFollowupToolRender(props: ToolProps) {
  const data = useData()
  const sessionId = createMemo(() => {
    if (typeof props.metadata.sessionId === "string" && props.metadata.sessionId) return props.metadata.sessionId
    return taskManageSessionId(props.input, props.metadata)
  })
  const agent = createMemo(() => {
    if (typeof props.input.agent === "string" && props.input.agent) return props.input.agent
    if (typeof props.metadata.agent === "string" && props.metadata.agent) return props.metadata.agent
    const id = sessionId()
    if (!id) return
    return data.store.session?.find((session) => session.id === id)?.agent
  })
  const description = createMemo(
    () =>
      (typeof props.metadata.title === "string" && props.metadata.title) ||
      (typeof props.input.title === "string" && props.input.title) ||
      (typeof props.input.prompt === "string" && props.input.prompt) ||
      undefined,
  )
  const background = createMemo(() => props.metadata.background !== false)

  return (
    <div data-component="task-tool-list">
      <TaskCard
        status={props.status}
        agent={agent()}
        description={description()}
        sessionId={sessionId()}
        background={background()}
        followup
      />
    </div>
  )
}

function TaskManageToolRender(props: ToolProps) {
  const data = useData()
  const i18n = useI18n()
  const location = useLocation()
  const title = createMemo(() => i18n.t(taskManageTitleKey(props.tool)))
  const subtitle = createMemo(() => taskManageSubtitle(props.input, props.metadata))
  const childSessionId = createMemo(() => taskManageSessionId(props.input, props.metadata))
  const href = createMemo(() => sessionLink(childSessionId(), location.pathname, data.sessionHref))
  const clickable = createMemo(() => !!(childSessionId() && (data.navigateToSession || href())))
  const output = createMemo(() => {
    const text = typeof props.output === "string" ? props.output.trim() : ""
    return text || undefined
  })
  const linkOnly = createMemo(() => clickable() && !output())

  const openSession = () => {
    const id = childSessionId()
    if (!id) return
    if (data.navigateToSession) {
      data.navigateToSession(id)
      return
    }
    const value = href()
    if (value) window.location.assign(value)
  }

  const navigate = (event: MouseEvent) => {
    if (!data.navigateToSession) return
    if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    event.preventDefault()
    openSession()
  }
  const navigateKey = (event: KeyboardEvent) => {
    if (!linkOnly() || href()) return
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    openSession()
  }

  return (
    <BasicTool
      {...props}
      icon="task"
      hideDetails={!output()}
      defaultOpen={false}
      triggerAsLink={linkOnly()}
      triggerHref={linkOnly() ? href() : undefined}
      clickable={linkOnly()}
      onTriggerClick={linkOnly() ? navigate : undefined}
      onTriggerKeyDown={linkOnly() ? navigateKey : undefined}
      trigger={{
        title: title(),
        subtitle: subtitle(),
        subtitleClass: clickable() && output() ? "clickable subagent-link" : undefined,
        action: clickable() ? (
          <span data-component="tool-action">
            <Icon name="square-arrow-top-right" size="small" />
          </span>
        ) : undefined,
      }}
      onSubtitleClick={clickable() && output() ? openSession : undefined}
    >
      <Show when={output()}>
        <div
          data-component="tool-output"
          data-scrollable
          tabIndex={0}
          role="region"
          aria-label={i18n.t("ui.scrollView.ariaLabel")}
        >
          <Markdown text={output()!} />
        </div>
      </Show>
    </BasicTool>
  )
}

ToolRegistry.register({
  name: "task_async_followup",
  render(props) {
    return <TaskFollowupToolRender {...props} />
  },
})

for (const name of ["task_async_status", "task_async_wait", "task_async_abort"] as const) {
  ToolRegistry.register({
    name,
    render(props) {
      return <TaskManageToolRender {...props} />
    },
  })
}

ToolRegistry.register({
  name: "bash",
  render(props) {
    const i18n = useI18n()
    const pending = () => props.status === "pending" || props.status === "running"
    const sawPending = pending()
    const text = createMemo(() => {
      const cmd = props.input.command ?? props.metadata.command ?? ""
      const out = stripAnsi(props.output || props.metadata.output || "").replace(/\r\n?/g, "\n")
      return `$ ${cmd}${out ? "\n\n" + out : ""}`
    })
    const [copied, setCopied] = createSignal(false)

    const handleCopy = async () => {
      const content = text()
      if (!content) return
      if (await writeClipboard(content)) {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }
    }

    return (
      <BasicTool
        {...props}
        icon="console"
        trigger={(open) => (
          <div data-slot="basic-tool-tool-info-structured">
            <div data-slot="basic-tool-tool-info-main">
              <span data-slot="basic-tool-tool-title">
                <TextShimmer text={i18n.t("ui.tool.shell")} active={pending()} />
              </span>
              <Show when={!pending() && !open() && props.input.command}>
                <ShellSubmessage text={props.input.command} animate={sawPending} />
              </Show>
            </div>
          </div>
        )}
      >
        <div data-component="bash-output">
          <div data-slot="bash-copy">
            <TooltipV2 value={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copy")} placement="top">
              <IconButtonV2
                icon={<IconV2 name={copied() ? "check" : "outline-copy"} size="small" />}
                size="normal"
                variant="ghost-muted"
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleCopy}
                aria-label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copy")}
              />
            </TooltipV2>
          </div>
          <div
            data-slot="bash-scroll"
            data-scrollable
            tabIndex={0}
            role="region"
            aria-label={i18n.t("ui.scrollView.ariaLabel")}
          >
            <pre data-slot="bash-pre">
              <code>{text()}</code>
            </pre>
          </div>
        </div>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "edit",
  render(props) {
    const i18n = useI18n()
    const fileComponent = useFileComponent()
    const diagnostics = createMemo(() => getDiagnostics(props.metadata.diagnostics, props.input.filePath))
    const path = createMemo(() => props.metadata?.filediff?.file || props.input.filePath || "")
    const filename = () => getFilename(props.input.filePath ?? "")
    const pending = () => props.status === "pending" || props.status === "running"
    const diffSource = createMemo(
      () => {
        const filediff = props.metadata?.filediff
        if (!filediff) return
        return {
          file: filediff.file || props.input.filePath || "",
          patch: typeof filediff.patch === "string" ? filediff.patch : undefined,
          before: typeof filediff.before === "string" ? filediff.before : undefined,
          after: typeof filediff.after === "string" ? filediff.after : undefined,
        }
      },
      undefined,
      {
        equals: (a, b) =>
          a?.file === b?.file && a?.patch === b?.patch && a?.before === b?.before && a?.after === b?.after,
      },
    )

    const fileCompProps = createMemo(() => {
      try {
        const source = diffSource()
        if (source) {
          const fileDiff = resolveFileDiff(source)
          if (fileDiff) return { fileDiff, hunkSeparators: fileDiff.isPartial ? "simple" : "line-info-basic" }
        }
      } catch {}

      return {
        before: {
          name: props.metadata?.filediff?.file || props.input.filePath,
          contents: props.metadata?.filediff?.before || props.input.oldString || "",
        },
        after: {
          name: props.metadata?.filediff?.file || props.input.filePath,
          contents: props.metadata?.filediff?.after || props.input.newString || "",
        },
      }
    })

    return (
      <div data-component="edit-tool">
        <BasicTool
          {...props}
          icon="code-lines"
          defer={props.deferContent !== false}
          trigger={
            <div data-component="edit-trigger">
              <div data-slot="message-part-title-area">
                <div data-slot="message-part-title">
                  <span data-slot="message-part-title-text">
                    <TextShimmer text={i18n.t("ui.messagePart.title.edit")} active={pending()} />
                  </span>
                  <Show when={!pending()}>
                    <span data-slot="message-part-title-filename">{filename()}</span>
                  </Show>
                </div>
                <Show when={!pending() && props.input.filePath?.includes("/")}>
                  <div data-slot="message-part-path">
                    <span data-slot="message-part-directory">{getDirectory(props.input.filePath!)}</span>
                  </div>
                </Show>
              </div>
              <div data-slot="message-part-actions">
                <Show when={!pending() && props.metadata.filediff}>
                  <DiffChanges changes={props.metadata.filediff} />
                </Show>
                <OpenFileButton filePath={props.input.filePath ?? ""} onViewFile={props.onViewFile} />
              </div>
            </div>
          }
        >
          <Show when={path()}>
            <ToolFileAccordion
              path={path()}
              actions={
                <Show when={!pending() && props.metadata.filediff}>
                  <DiffChanges changes={props.metadata.filediff!} />
                </Show>
              }
            >
              <div data-component="edit-content">
                <Dynamic
                  component={fileComponent}
                  mode="diff"
                  virtualize={props.virtualizeDiff}
                  onRendered={props.onContentRendered}
                  {...fileCompProps()}
                />
              </div>
            </ToolFileAccordion>
          </Show>
          <DiagnosticsDisplay diagnostics={diagnostics()} />
        </BasicTool>
      </div>
    )
  },
})

ToolRegistry.register({
  name: "write",
  render(props) {
    const i18n = useI18n()
    const fileComponent = useFileComponent()
    const diagnostics = createMemo(() => getDiagnostics(props.metadata.diagnostics, props.input.filePath))
    const path = createMemo(() => props.input.filePath || "")
    const filename = () => getFilename(props.input.filePath ?? "")
    const pending = () => props.status === "pending" || props.status === "running"
    return (
      <div data-component="write-tool">
        <BasicTool
          {...props}
          icon="code-lines"
          defer={props.deferContent !== false}
          trigger={
            <div data-component="write-trigger">
              <div data-slot="message-part-title-area">
                <div data-slot="message-part-title">
                  <span data-slot="message-part-title-text">
                    <TextShimmer text={i18n.t("ui.messagePart.title.write")} active={pending()} />
                  </span>
                  <Show when={!pending()}>
                    <span data-slot="message-part-title-filename">{filename()}</span>
                  </Show>
                </div>
                <Show when={!pending() && props.input.filePath?.includes("/")}>
                  <div data-slot="message-part-path">
                    <span data-slot="message-part-directory">{getDirectory(props.input.filePath!)}</span>
                  </div>
                </Show>
              </div>
              <div data-slot="message-part-actions">
                {/* <DiffChanges diff={diff} /> */}
                <OpenFileButton filePath={props.input.filePath ?? ""} onViewFile={props.onViewFile} />
              </div>
            </div>
          }
        >
          <Show when={props.input.content && path()}>
            <ToolFileAccordion path={path()}>
              <div data-component="write-content">
                <Dynamic
                  component={fileComponent}
                  mode="text"
                  file={{
                    name: props.input.filePath,
                    contents: props.input.content,
                    cacheKey: checksum(props.input.content),
                  }}
                  overflow="scroll"
                  onRendered={props.onContentRendered}
                />
              </div>
            </ToolFileAccordion>
          </Show>
          <DiagnosticsDisplay diagnostics={diagnostics()} />
        </BasicTool>
      </div>
    )
  },
})

function MultiFileEditRender(props: ToolProps & { titleKey: string }) {
  const i18n = useI18n()
  const fileComponent = useFileComponent()
  const files = createMemo(() => patchFiles(props.metadata.files))
  const pending = createMemo(() => props.status === "pending" || props.status === "running")
  const single = createMemo(() => {
    const list = files()
    if (list.length !== 1) return
    return list[0]
  })
  const [expanded, setExpanded] = createSignal<string[]>([])
  let seeded = false

  createEffect(() => {
    const list = files()
    if (list.length === 0) return
    if (seeded) return
    seeded = true
    setExpanded(list.filter((f) => f.type !== "delete").map((f) => f.filePath))
  })

  const subtitle = createMemo(() => {
    const count = files().length
    if (count === 0) return ""
    return `${count} ${i18n.t(count > 1 ? "ui.common.file.other" : "ui.common.file.one")}`
  })

  return (
    <Show
      when={single()}
      fallback={
        <div data-component="apply-patch-tool">
          <BasicTool
            {...props}
            icon="code-lines"
            defer={props.deferContent !== false}
            trigger={{
              title: i18n.t(props.titleKey),
              subtitle: subtitle(),
            }}
          >
              <Show when={files().length > 0}>
                <Accordion
                  multiple
                  data-scope="apply-patch"
                  style={{ "--sticky-accordion-offset": "calc(32px + var(--tool-content-gap))" }}
                  value={expanded()}
                  onChange={(value) => setExpanded(Array.isArray(value) ? value : value ? [value] : [])}
                >
                  <For each={files()}>
                    {(file) => {
                      const active = createMemo(() => expanded().includes(file.filePath))
                      const [visible, setVisible] = createSignal(false)

                      createEffect(() => {
                        if (!active()) {
                          setVisible(false)
                          return
                        }

                        requestAnimationFrame(() => {
                          if (!active()) return
                          setVisible(true)
                        })
                      })

                      return (
                        <Accordion.Item value={file.filePath} data-type={file.type}>
                          <StickyAccordionHeader>
                            <Accordion.Trigger>
                              <div data-slot="apply-patch-trigger-content">
                                <div data-slot="apply-patch-file-info">
                                  <FileIcon node={{ path: file.relativePath, type: "file" }} />
                                  <div data-slot="apply-patch-file-name-container">
                                    <Show when={file.relativePath.includes("/")}>
                                      <span data-slot="apply-patch-directory">{`\u202A${getDirectory(file.relativePath)}\u202C`}</span>
                                    </Show>
                                    <span data-slot="apply-patch-filename">{getFilename(file.relativePath)}</span>
                                  </div>
                                </div>
                                <div data-slot="apply-patch-trigger-actions">
                                  <Switch>
                                    <Match when={file.type === "add"}>
                                      <span data-slot="apply-patch-change" data-type="added">
                                        {i18n.t("ui.patch.action.created")}
                                      </span>
                                    </Match>
                                    <Match when={file.type === "delete"}>
                                      <span data-slot="apply-patch-change" data-type="removed">
                                        {i18n.t("ui.patch.action.deleted")}
                                      </span>
                                    </Match>
                                    <Match when={file.type === "move"}>
                                      <span data-slot="apply-patch-change" data-type="modified">
                                        {i18n.t("ui.patch.action.moved")}
                                      </span>
                                    </Match>
                                    <Match when={true}>
                                      <DiffChanges changes={{ additions: file.additions, deletions: file.deletions }} />
                                    </Match>
                                  </Switch>
                                  <Icon name="chevron-grabber-vertical" size="small" />
                                </div>
                              </div>
                            </Accordion.Trigger>
                          </StickyAccordionHeader>
                          <Accordion.Content>
                            <Show when={props.deferContent === false || visible()}>
                              <div data-component="apply-patch-file-diff">
                                <Dynamic
                                  component={fileComponent}
                                  mode="diff"
                                  virtualize={props.virtualizeDiff}
                                  fileDiff={file.view.fileDiff}
                                  hunkSeparators={file.view.fileDiff.isPartial ? "simple" : "line-info-basic"}
                                  onRendered={props.onContentRendered}
                                />
                              </div>
                            </Show>
                          </Accordion.Content>
                        </Accordion.Item>
                      )
                    }}
                  </For>
                </Accordion>
              </Show>
            </BasicTool>
          </div>
        }
      >
        <div data-component="apply-patch-tool">
          <BasicTool
            {...props}
            icon="code-lines"
            defer={props.deferContent !== false}
            trigger={
              <div data-component="edit-trigger">
                <div data-slot="message-part-title-area">
                  <div data-slot="message-part-title">
                    <span data-slot="message-part-title-text">
                      <TextShimmer text={i18n.t(props.titleKey)} active={pending()} />
                    </span>
                    <Show when={!pending()}>
                      <span data-slot="message-part-title-filename">{getFilename(single()!.relativePath)}</span>
                    </Show>
                  </div>
                  <Show when={!pending() && single()!.relativePath.includes("/")}>
                    <div data-slot="message-part-path">
                      <span data-slot="message-part-directory">{getDirectory(single()!.relativePath)}</span>
                    </div>
                  </Show>
                </div>
                <div data-slot="message-part-actions">
                  <Show when={!pending()}>
                    <DiffChanges changes={{ additions: single()!.additions, deletions: single()!.deletions }} />
                  </Show>
                  <OpenFileButton filePath={single()!.filePath} onViewFile={props.onViewFile} />
                </div>
              </div>
            }
          >
            <ToolFileAccordion
              path={single()!.relativePath}
              actions={
                <Switch>
                  <Match when={single()!.type === "add"}>
                    <span data-slot="apply-patch-change" data-type="added">
                      {i18n.t("ui.patch.action.created")}
                    </span>
                  </Match>
                  <Match when={single()!.type === "delete"}>
                    <span data-slot="apply-patch-change" data-type="removed">
                      {i18n.t("ui.patch.action.deleted")}
                    </span>
                  </Match>
                  <Match when={single()!.type === "move"}>
                    <span data-slot="apply-patch-change" data-type="modified">
                      {i18n.t("ui.patch.action.moved")}
                    </span>
                  </Match>
                  <Match when={true}>
                    <DiffChanges changes={{ additions: single()!.additions, deletions: single()!.deletions }} />
                  </Match>
                </Switch>
              }
            >
              <div data-component="apply-patch-file-diff">
                <Dynamic
                  component={fileComponent}
                  mode="diff"
                  virtualize={props.virtualizeDiff}
                  fileDiff={single()!.view.fileDiff}
                  onRendered={props.onContentRendered}
                />
              </div>
            </ToolFileAccordion>
          </BasicTool>
        </div>
      </Show>
    )
}

ToolRegistry.register({
  name: "apply_patch",
  render(props) {
    return <MultiFileEditRender {...props} titleKey="ui.tool.patch" />
  },
})

ToolRegistry.register({
  name: "multiedit",
  render(props) {
    return <MultiFileEditRender {...props} titleKey="ui.messagePart.title.multiedit" />
  },
})

ToolRegistry.register({
  name: "todowrite",
  render(props) {
    const i18n = useI18n()
    const todos = createMemo(() => {
      const meta = props.metadata?.todos
      if (Array.isArray(meta)) return meta

      const input = props.input.todos
      if (Array.isArray(input)) return input

      return []
    })

    const subtitle = createMemo(() => {
      const list = todos()
      if (list.length === 0) return ""
      return `${list.filter((t: Todo) => t.status === "completed").length}/${list.length}`
    })

    return (
      <BasicTool
        {...props}
        defaultOpen
        icon="checklist"
        trigger={{
          title: i18n.t("ui.tool.todos"),
          subtitle: subtitle(),
        }}
      >
        <Show when={todos().length}>
          <div data-component="todos">
            <For each={todos()}>
              {(todo: Todo) => (
                <Checkbox readOnly checked={todo.status === "completed"}>
                  <span
                    data-slot="message-part-todo-content"
                    data-completed={todo.status === "completed" ? "completed" : undefined}
                  >
                    {todo.content}
                  </span>
                </Checkbox>
              )}
            </For>
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "question",
  render(props) {
    const i18n = useI18n()
    const questions = createMemo(() => (props.input.questions ?? []) as QuestionInfo[])
    const answers = createMemo(() => (props.metadata.answers ?? []) as QuestionAnswer[])
    const completed = createMemo(() => answers().length > 0)

    const subtitle = createMemo(() => {
      const count = questions().length
      if (count === 0) return ""
      if (completed()) return i18n.t("ui.question.subtitle.answered", { count })
      return `${count} ${i18n.t(count > 1 ? "ui.common.question.other" : "ui.common.question.one")}`
    })

    return (
      <BasicTool
        {...props}
        defaultOpen={completed()}
        icon="bubble-5"
        trigger={{
          title: i18n.t("ui.tool.questions"),
          subtitle: subtitle(),
        }}
      >
        <Show when={completed()}>
          <div data-component="question-answers">
            <For each={questions()}>
              {(q, i) => {
                const answer = () => answers()[i()] ?? []
                return (
                  <div data-slot="question-answer-item">
                    <div data-slot="question-text">{q.question}</div>
                    <div data-slot="answer-text">{answer().join(", ") || i18n.t("ui.question.answer.none")}</div>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "skill",
  render(props) {
    const i18n = useI18n()
    const title = createMemo(() => props.input.name || i18n.t("ui.tool.skill"))
    const running = createMemo(() => props.status === "pending" || props.status === "running")

    const titleContent = () => <TextShimmer text={title()} active={running()} />

    const trigger = () => (
      <div data-slot="basic-tool-tool-info-structured">
        <div data-slot="basic-tool-tool-info-main">
          <span data-slot="basic-tool-tool-title" class="capitalize agent-title">
            {titleContent()}
          </span>
        </div>
      </div>
    )

    return <BasicTool icon="brain" status={props.status} trigger={trigger()} hideDetails />
  },
})
