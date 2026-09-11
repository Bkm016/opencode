import { Show, Index, createMemo, createSignal, createEffect, onCleanup, type JSX } from "solid-js"
import stripAnsi from "strip-ansi"
import type { AssistantMessage, ToolPart } from "@opencode-ai/sdk/v2"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { AnimatedCountList } from "./tool-count-summary"
import { ToolStatusTitle } from "./tool-status-title"
import { TextShimmer } from "@opencode-ai/ui/text-shimmer"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Icon } from "@opencode-ai/ui/icon"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { useData } from "../context"
import { getDirectory as _getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { ComputerUseTool } from "./computer-use-tool"
import "./edit-tool-card.css"
import {
  ToolGroupRegistry,
  computeToolGroupDuration,
  isContextGroupTool,
  isComputerUseGroupTool,
  isPythonGroupTool,
  isBashGroupTool,
  isHistoryGroupTool,
  isWebGroupTool,
  type PartRef,
} from "./message-part-groups"

export function relativizeProjectPath(path: string, directory?: string) {
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

export function formatToolDuration(part: ToolPart): string | undefined {
  const time = part.state && "time" in part.state ? (part.state as any).time : undefined
  if (!time || typeof time.start !== "number" || typeof time.end !== "number") return undefined
  const diff = Math.max(0, time.end - time.start)
  if (diff < 1000) return `${diff}ms`
  if (diff < 60000) return `${(diff / 1000).toFixed(diff < 10000 ? 2 : 1)}s`
  const mins = Math.floor(diff / 60000)
  const secs = Math.round((diff % 60000) / 1000)
  return `${mins}m ${secs}s`
}

export function contextToolTrigger(part: ToolPart, i18n: ReturnType<typeof useI18n>, directory?: string) {
  const input = (part.state.input ?? {}) as Record<string, unknown>
  const path = typeof input.path === "string" ? input.path : "/"
  const filePath = typeof input.filePath === "string" ? input.filePath : undefined
  const pattern = typeof input.pattern === "string" ? input.pattern : undefined
  const include = typeof input.include === "string" ? input.include : undefined
  const offset = typeof input.offset === "number" ? input.offset : undefined
  const limit = typeof input.limit === "number" ? input.limit : undefined

  const dir = (p: string | undefined) => relativizeProjectPath(_getDirectory(p), directory)

  switch (part.tool) {
    case "read": {
      const args: string[] = []
      if (offset !== undefined) args.push("offset=" + offset)
      if (limit !== undefined) args.push("limit=" + limit)
      const detail =
        offset !== undefined && limit !== undefined
          ? `L${offset}–${offset + limit}`
          : offset !== undefined
            ? `L${offset}+`
            : limit !== undefined
              ? `${limit} lines`
              : undefined
      const targetFile = filePath ? getFilename(filePath) : path !== "/" ? getFilename(path) : ""
      return {
        tag: "READ",
        title: i18n.t("ui.tool.read"),
        target: targetFile,
        targetTooltip: filePath || path,
        detail,
        path: filePath ? dir(filePath) : undefined,
        fullPath: filePath || path,
        subtitle: targetFile,
        args,
      }
    }
    case "list_dir": {
      const dirPath = (typeof input.path === "string" && input.path) || path || "/"
      return {
        tag: "LIST",
        title: i18n.t("ui.tool.list"),
        target: dir(dirPath),
        targetTooltip: dirPath,
        detail: undefined,
        path: undefined,
        fullPath: dirPath,
        subtitle: dir(dirPath),
        args: [],
      }
    }
    case "glob":
      return {
        tag: "GLOB",
        title: i18n.t("ui.tool.glob"),
        target: pattern || "*",
        targetTooltip: pattern,
        detail: undefined,
        path: dir(path),
        fullPath: path,
        subtitle: dir(path),
        args: pattern ? ["pattern=" + pattern] : [],
      }
    case "grep": {
      const args: string[] = []
      if (pattern) args.push("pattern=" + pattern)
      if (include) args.push("include=" + include)
      return {
        tag: "GREP",
        title: i18n.t("ui.tool.grep"),
        target: pattern || "*",
        targetTooltip: pattern,
        detail: include ? `in ${include}` : undefined,
        path: dir(path),
        fullPath: path,
        subtitle: dir(path),
        args,
      }
    }
    case "history_grep": {
      const args: string[] = []
      if (input.source === "task") args.push("source=task")
      if (typeof input.chunk_id === "string" && input.chunk_id) args.push("chunk=" + input.chunk_id)
      if (typeof input.message_id === "string" && input.message_id) args.push("message=" + input.message_id)
      if (typeof input.part_id === "string" && input.part_id) args.push("part=" + input.part_id)
      const patternText = typeof input.pattern === "string" ? input.pattern : ""
      const meta = ("metadata" in part.state ? (part.state as any).metadata : undefined) ?? {}
      const matches = typeof meta.matches === "number" ? meta.matches : undefined
      const detail =
        matches !== undefined
          ? i18n.t("ui.historyTool.matches", { count: matches })
          : input.source === "task"
            ? "task"
            : typeof input.chunk_id === "string" && input.chunk_id
              ? `chunk ${input.chunk_id}`
              : undefined
      return {
        tag: "H-GREP",
        title: input.source === "task" ? i18n.t("ui.historyTool.grep.evidenceDone") : i18n.t("ui.tool.historyGrep"),
        target: patternText || (input.source === "task" ? i18n.t("ui.historyTool.source.taskEvidence") : "history"),
        targetTooltip: patternText,
        detail,
        path: undefined,
        subtitle: patternText,
        args,
      }
    }
    case "history_list": {
      const args: string[] = []
      if (input.source === "task") args.push("source=task")
      if (typeof input.chunk_id === "string" && input.chunk_id) args.push("chunk=" + input.chunk_id)
      if (typeof input.message_id === "string" && input.message_id) args.push("message=" + input.message_id)
      if (typeof input.part_id === "string" && input.part_id) args.push("part=" + input.part_id)
      if (typeof input.offset === "number") args.push("offset=" + input.offset)
      if (typeof input.limit === "number") args.push("limit=" + input.limit)
      const ref =
        typeof input.chunk_id === "string" && input.chunk_id
          ? `chunk ${input.chunk_id}`
          : typeof input.message_id === "string" && input.message_id
            ? input.part_id
              ? `${input.message_id}:${input.part_id}`
              : input.message_id
            : input.source === "task"
              ? i18n.t("ui.historyTool.source.taskEvidence")
              : "history"
      const meta = ("metadata" in part.state ? (part.state as any).metadata : undefined) ?? {}
      const lines = typeof meta.lines === "number" ? meta.lines : undefined
      const detail =
        lines !== undefined
          ? i18n.t("ui.historyTool.lines", { count: lines })
          : offset !== undefined && limit !== undefined
            ? `L${offset}–${offset + limit}`
            : offset !== undefined
              ? `L${offset}+`
              : undefined
      return {
        tag: "H-LIST",
        title: input.source === "task" ? i18n.t("ui.historyTool.list.evidenceDone") : i18n.t("ui.tool.historyList"),
        target: ref,
        targetTooltip: ref,
        detail,
        path: undefined,
        subtitle: ref,
        args,
      }
    }
    case "webfetch": {
      const rawUrl = typeof input.url === "string" ? input.url : ""
      return {
        tag: "FETCH",
        title: i18n.t("ui.tool.webfetch"),
        target: rawUrl,
        targetTooltip: rawUrl,
        detail: undefined,
        path: undefined,
        subtitle: rawUrl,
        args: [],
      }
    }
    case "websearch": {
      const query = typeof input.query === "string" ? input.query : ""
      return {
        tag: "SEARCH",
        title: i18n.t("ui.tool.websearch"),
        target: query,
        targetTooltip: query,
        detail: undefined,
        path: undefined,
        subtitle: query,
        args: [],
      }
    }
    default: {
      const subtitle = typeof input.path === "string" ? input.path : undefined
      return {
        tag: (part.tool || "TOOL").slice(0, 6).toUpperCase(),
        title: part.tool,
        target: subtitle || part.tool,
        targetTooltip: subtitle,
        detail: undefined,
        path: undefined,
        subtitle,
        args: [],
      }
    }
  }
}

export function contextToolSummary(parts: ToolPart[]) {
  const read = parts.filter((part) => part.tool === "read").length
  const search = parts.filter((part) => part.tool === "glob" || part.tool === "grep").length
  const list = parts.filter((part) => part.tool === "list_dir").length
  return { read, search, list }
}

function ContextToolRow(props: { part: ToolPart }) {
  const i18n = useI18n()
  const data = useData()
  const trigger = createMemo(() => contextToolTrigger(props.part, i18n, data.directory))
  const running = createMemo(() => props.part.state.status === "pending" || props.part.state.status === "running")
  const duration = createMemo(() => formatToolDuration(props.part))
  const isWebfetch = createMemo(() => props.part.tool === "webfetch")
  const url = createMemo(() => {
    const u = (props.part.state.input as any)?.url
    return typeof u === "string" && u.length > 0 ? u : undefined
  })

  return (
    <div data-component="context-tool-row">
      <div data-slot="context-tool-main">
        <span data-slot="context-tool-tag" data-tool={props.part.tool}>
          {trigger().tag}
        </span>
        <span
          data-slot="context-tool-target"
          title={trigger().targetTooltip || trigger().target || trigger().title}
        >
          <Show
            when={isWebfetch() && url()}
            fallback={<TextShimmer text={trigger().target || trigger().title} active={running()} />}
          >
            <a
              href={url()}
              target="_blank"
              rel="noopener noreferrer"
              class="subagent-link truncate hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              <TextShimmer text={trigger().target || trigger().title} active={running()} />
            </a>
          </Show>
        </span>
        <Show when={!running() && trigger().detail}>
          <span data-slot="context-tool-detail">{trigger().detail}</span>
        </Show>
        <Show when={!running() && trigger().path}>
          <span data-slot="context-tool-path" title={trigger().fullPath || trigger().path}>
            {trigger().path}
          </span>
        </Show>
      </div>
      <div data-slot="context-tool-meta">
        <Show when={isWebfetch() && url()}>
          <a
            href={url()}
            target="_blank"
            rel="noopener noreferrer"
            class="text-text-weak hover:text-text-base mr-1 inline-flex items-center"
            onClick={(e) => e.stopPropagation()}
          >
            <IconV2 name="square-arrow-top-right" size="small" />
          </a>
        </Show>
        <Show when={running()}>
          <span data-slot="context-tool-running">
            <Spinner class="size-3" />
          </span>
        </Show>
        <Show when={!running() && duration()}>
          <span data-slot="context-tool-duration">{duration()}</span>
        </Show>
      </div>
    </div>
  )
}

/**
 * 通用的脚本/命令行执行类工具条目组件
 * 彻底收敛 bash 与 python 的重复 DOM、滚动定位、复制及卡片逻辑。
 */
function ScriptGroupItem(props: {
  part: ToolPart
  tag: string
  codeKey: "command" | "code"
  componentPrefix: "bash" | "python"
}) {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)
  const pending = () => props.part.state.status === "pending" || props.part.state.status === "running"
  const errored = () => props.part.state.status === "error"
  const errorText = createMemo(() => {
    if (!errored()) return ""
    const meta = ("metadata" in props.part.state ? (props.part.state as any).metadata : undefined) ?? {}
    if (meta.interrupted === true) return i18n.t("ui.message.interrupted")
    const raw = props.part.state.status === "error" ? props.part.state.error : meta.error
    return typeof raw === "string" ? raw.replace(/^Error:\s*/, "").trim() : ""
  })

  const input = (props.part.state.input ?? {}) as Record<string, unknown>
  const meta = (("metadata" in props.part.state ? (props.part.state as any).metadata : undefined) ?? {}) as Record<string, unknown>
  const remote = createMemo(() => {
    const value = input.host ?? meta.host
    return typeof value === "string" && value ? value : undefined
  })
  const host = createMemo(() => remote() ?? "localhost")
  const workdir = createMemo(() => {
    const value = input.workdir ?? meta.workdir
    return typeof value === "string" && value ? value : undefined
  })
  const scriptContent = createMemo(() => {
    const raw = typeof input[props.codeKey] === "string" ? input[props.codeKey] : (meta[props.codeKey] ?? "")
    return String(raw).replace(/\r\n?/g, "\n").trimEnd()
  })
  const scriptPreview = createMemo(() => {
    const lines = scriptContent().split("\n")
    const first = lines.find((line: string) => line.trim()) ?? ""
    const extra = lines.length - 1
    return extra > 0 ? `${first.trimEnd()} … (${extra + 1} lines)` : first
  })
  const output = createMemo(() => {
    const raw = props.part.state.status === "completed" ? (props.part.state as any).output : meta.output
    const text = typeof raw === "string" ? raw : ""
    return stripAnsi(text).replace(/\r\n?/g, "\n").trimEnd()
  })
  const exit = createMemo(() => {
    const code = meta.exit
    return typeof code === "number" ? code : undefined
  })
  const failed = createMemo(() => exit() !== undefined && exit() !== 0)
  const duration = createMemo(() => formatToolDuration(props.part))
  const [copied, setCopied] = createSignal(false)
  let scrollRef: HTMLDivElement | undefined

  const scrollToEnd = () => {
    const el = scrollRef
    if (!el) return
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
  }

  createEffect(() => {
    output()
    scrollToEnd()
  })

  const handleCopy = async () => {
    const prefix = props.tag === "$" ? "$ " : ""
    const content = `${prefix}${scriptContent()}${output() ? "\n\n" + output() : ""}`
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div data-component={`${props.componentPrefix}-item-container`} data-open={open() ? "true" : "false"}>
      {/* 触发器行：100% 复用 context-tool-row 结构与类名，保持 25px 高度与相同的 hover 效果 */}
      <div
        data-component="context-tool-row"
        class="cursor-pointer"
        onClick={() => setOpen(!open())}
      >
        <div data-slot="context-tool-main">
          <span data-slot="context-tool-tag">{props.tag}</span>
          <span data-slot="context-tool-target" title={scriptPreview()}>
            <TextShimmer text={scriptPreview()} active={pending()} />
          </span>
          <Show when={!pending() && (props.componentPrefix === "python" ? host() : remote())}>
            <span data-slot="context-tool-path">@{host()}</span>
          </Show>
        </div>
        <div data-slot="context-tool-meta">
          <Show when={pending()}>
            <span data-slot="context-tool-running">
              <Spinner class="size-3" />
            </span>
          </Show>
          <Show when={!pending() && duration()}>
            <span data-slot="context-tool-duration">{duration()}</span>
          </Show>
          <Show when={!pending() && failed()}>
            <span data-slot="bash-trigger-exit" data-exit="fail">
              {i18n.t("ui.tool.shell.exit")} {exit()}
            </span>
          </Show>
          <Show when={errored()}>
            <span data-slot="bash-trigger-exit" data-exit="fail" title={errorText() || undefined}>
              {i18n.t("ui.toolErrorCard.failed")}
            </span>
          </Show>
          <span class="edit-tool-card-arrow" data-open={open() ? "true" : "false"}>
            <Icon name="chevron-down" size="small" />
          </span>
        </div>
      </div>

      {/* 展开内容区：使用 CSS Grid 0fr -> 1fr 平滑下落动画容器 */}
      <div class="edit-tool-card-body-wrapper" data-open={open() ? "true" : "false"}>
        <div class="edit-tool-card-body-inner">
          <div data-component="bash-output">
            <div data-slot="bash-header">
              <Show when={host()}>
                <span data-slot="bash-meta">
                  <span data-slot="bash-meta-key">{i18n.t("ui.tool.shell.host")}</span>
                  <span data-slot="bash-meta-value" data-accent>
                    {host()}
                  </span>
                </span>
              </Show>
              <Show when={workdir()}>
                <span data-slot="bash-meta">
                  <span data-slot="bash-meta-key">{i18n.t("ui.tool.shell.workdir")}</span>
                  <span data-slot="bash-meta-value">{workdir()}</span>
                </span>
              </Show>
              <span data-slot="bash-header-tail">
                <Show when={exit() !== undefined}>
                  <span data-slot="bash-meta">
                    <span data-slot="bash-meta-key">{i18n.t("ui.tool.shell.exit")}</span>
                    <span data-slot="bash-meta-value" data-exit={exit() === 0 ? "ok" : "fail"}>
                      {exit()}
                    </span>
                  </span>
                </Show>
                <TooltipV2 value={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copy")} placement="top">
                  <IconButtonV2
                    icon={<IconV2 name={copied() ? "check" : "outline-copy"} size="small" />}
                    size="normal"
                    variant="ghost-muted"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      e.stopPropagation()
                      void handleCopy()
                    }}
                    aria-label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copy")}
                  />
                </TooltipV2>
              </span>
            </div>
            <div
              data-slot="bash-scroll"
              data-scrollable
              tabIndex={0}
              role="region"
              aria-label={i18n.t("ui.scrollView.ariaLabel")}
              ref={(el) => {
                scrollRef = el
                scrollToEnd()
              }}
            >
              <pre data-slot="bash-pre" data-section="command">
                <code>{scriptContent()}</code>
              </pre>
              <Show when={output()}>
                <pre data-slot="bash-pre" data-section="output">
                  <code>{output()}</code>
                </pre>
              </Show>
              <Show when={errored() && errorText()}>
                <pre data-slot="bash-pre" data-section="error">
                  <code>{errorText()}</code>
                </pre>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// 注册内建工具分组：已探索 (context)
ToolGroupRegistry.register({
  id: "context",
  match: isContextGroupTool,
  title: {
    active: (i18n) => i18n.t("ui.sessionTurn.status.gatheringContext"),
    done: (i18n) => i18n.t("ui.sessionTurn.status.gatheredContext"),
  },
  renderSummary({ parts, i18n }) {
    const summary = contextToolSummary(parts)
    return (
      <AnimatedCountList
        items={[
          {
            key: "read",
            count: summary.read,
            one: i18n.t("ui.messagePart.context.read.one"),
            other: i18n.t("ui.messagePart.context.read.other"),
          },
          {
            key: "search",
            count: summary.search,
            one: i18n.t("ui.messagePart.context.search.one"),
            other: i18n.t("ui.messagePart.context.search.other"),
          },
          {
            key: "list",
            count: summary.list,
            one: i18n.t("ui.messagePart.context.list.one"),
            other: i18n.t("ui.messagePart.context.list.other"),
          },
        ]}
        fallback=""
      />
    )
  },
  renderItem(itemProps) {
    return <ContextToolRow part={itemProps.part} />
  },
  componentName: "context-tool-group",
})

// 注册内建工具分组：电脑操作 (computerUse)
ToolGroupRegistry.register({
  id: "computerUse",
  match: isComputerUseGroupTool,
  title: {
    active: (i18n) => i18n.t("ui.sessionTurn.status.usingComputer"),
    done: (i18n) => i18n.t("ui.sessionTurn.status.usedComputer"),
  },
  renderSummary({ parts, i18n }) {
    const counts = { observe: 0, action: 0, error: 0 }
    for (const part of parts) {
      if (part.state.status === "error") counts.error++
      const action = (part.state.input as Record<string, unknown> | undefined)?.action
      if (action === "list_windows" || action === "list_apps" || action === "get_window_state" || action === "get_window") counts.observe++
      else counts.action++
    }
    return (
      <AnimatedCountList
        items={[
          {
            key: "observe",
            count: counts.observe,
            one: i18n.t("ui.messagePart.computerUse.observe.one"),
            other: i18n.t("ui.messagePart.computerUse.observe.other"),
          },
          {
            key: "action",
            count: counts.action,
            one: i18n.t("ui.messagePart.computerUse.action.one"),
            other: i18n.t("ui.messagePart.computerUse.action.other"),
          },
          {
            key: "error",
            count: counts.error,
            one: i18n.t("ui.messagePart.computerUse.error.one"),
            other: i18n.t("ui.messagePart.computerUse.error.other"),
          },
        ]}
        fallback=""
      />
    )
  },
  renderItem(itemProps) {
    const input = itemProps.part.state.input ?? {}
    const metadata = (itemProps.part.state as any).metadata ?? {}
    const output = itemProps.part.state.status === "completed" ? itemProps.part.state.output : undefined
    const error = itemProps.part.state.status === "error" ? itemProps.part.state.error : undefined
    const attachments = itemProps.part.state.status === "completed" ? itemProps.part.state.attachments : undefined

    return (
      <ComputerUseTool
        part={itemProps.part}
        tool="computer_use"
        input={input}
        metadata={metadata}
        output={output}
        status={itemProps.part.state.status}
        error={error}
        attachments={attachments}
        sessionID={itemProps.part.sessionID}
        partID={itemProps.part.id}
      />
    )
  },
  componentName: "computer-use-group",
})

// 注册内建工具分组：Python 脚本执行 (python)
ToolGroupRegistry.register({
  id: "python",
  match: isPythonGroupTool,
  title: {
    active: (i18n) => i18n.t("ui.sessionTurn.status.runningPython"),
    done: (i18n) => i18n.t("ui.sessionTurn.status.ranPython"),
  },
  renderSummary({ parts, i18n }) {
    return (
      <span>
        {parts.length === 1
          ? i18n.t("ui.messagePart.python.script.one", { count: 1 })
          : i18n.t("ui.messagePart.python.script.other", { count: parts.length })}
      </span>
    )
  },
  renderItem(itemProps) {
    return (
      <ScriptGroupItem
        part={itemProps.part}
        tag="python"
        codeKey="code"
        componentPrefix="python"
      />
    )
  },
  componentName: "python-tool-group",
})

// 注册内建工具分组：Bash 命令行执行 (bash)
ToolGroupRegistry.register({
  id: "bash",
  match: isBashGroupTool,
  title: {
    active: (i18n) => i18n.t("ui.sessionTurn.status.runningCommands"),
    done: (i18n) => i18n.t("ui.sessionTurn.status.ranCommands"),
  },
  renderSummary({ parts, i18n }) {
    return (
      <span>
        {parts.length === 1
          ? i18n.t("ui.messagePart.bash.command.one", { count: 1 })
          : i18n.t("ui.messagePart.bash.command.other", { count: parts.length })}
      </span>
    )
  },
  renderItem(itemProps) {
    return (
      <ScriptGroupItem
        part={itemProps.part}
        tag="$"
        codeKey="command"
        componentPrefix="bash"
      />
    )
  },
  componentName: "bash-tool-group",
})

// 注册内建工具分组：历史检索 (history)
ToolGroupRegistry.register({
  id: "history",
  match: isHistoryGroupTool,
  title: {
    active: (i18n) => i18n.t("ui.sessionTurn.status.searchingHistory") || "正在查阅历史",
    done: (i18n) => i18n.t("ui.sessionTurn.status.searchedHistory") || "已查阅历史",
  },
  renderSummary({ parts, i18n }) {
    const grepCount = parts.filter((part) => part.tool === "history_grep").length
    const listCount = parts.filter((part) => part.tool === "history_list").length
    return (
      <AnimatedCountList
        items={[
          {
            key: "grep",
            count: grepCount,
            one: i18n.t("ui.messagePart.context.search.one"),
            other: i18n.t("ui.messagePart.context.search.other"),
          },
          {
            key: "list",
            count: listCount,
            one: i18n.t("ui.messagePart.context.read.one"),
            other: i18n.t("ui.messagePart.context.read.other"),
          },
        ]}
        fallback=""
      />
    )
  },
  renderItem(itemProps) {
    return <ContextToolRow part={itemProps.part} />
  },
  componentName: "context-tool-group",
})

// 注册内建工具分组：网络访问 (web)
ToolGroupRegistry.register({
  id: "web",
  match: isWebGroupTool,
  title: {
    active: (i18n) => i18n.t("ui.sessionTurn.status.browsingWeb") || "正在访问网页",
    done: (i18n) => i18n.t("ui.sessionTurn.status.browsedWeb") || "已访问网页",
  },
  renderSummary({ parts, i18n }) {
    const fetchCount = parts.filter((part) => part.tool === "webfetch").length
    const searchCount = parts.filter((part) => part.tool === "websearch").length
    return (
      <AnimatedCountList
        items={[
          {
            key: "fetch",
            count: fetchCount,
            one: i18n.t("ui.messagePart.web.fetch.one"),
            other: i18n.t("ui.messagePart.web.fetch.other"),
          },
          {
            key: "search",
            count: searchCount,
            one: i18n.t("ui.messagePart.context.search.one"),
            other: i18n.t("ui.messagePart.context.search.other"),
          },
        ]}
        fallback=""
      />
    )
  },
  renderItem(itemProps) {
    return <ContextToolRow part={itemProps.part} />
  },
  componentName: "context-tool-group",
})

/**
 * 通用连续工具聚合组件
 * 统一处理折叠展开、执行状态、总纯耗时计算与条目分发渲染。
 */
export function GenericToolGroup(props: {
  group: { key: string; type: string; refs: PartRef[] }
  parts: ToolPart[]
  message?: AssistantMessage
  busy?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onSizeChange?: () => void
  shellToolDefaultOpen?: boolean
  editToolDefaultOpen?: boolean
  showAssistantCopyPartID?: string | null
  turnDurationMs?: number
  onCompactHere?: (messageID: string) => void
  renderFallbackItem?: (props: {
    part: ToolPart
    message?: AssistantMessage
    showAssistantCopyPartID?: string | null
    turnDurationMs?: number
    shellToolDefaultOpen?: boolean
    editToolDefaultOpen?: boolean
    onCompactHere?: (messageID: string) => void
  }) => JSX.Element
}) {
  const i18n = useI18n()
  const [localOpen, setLocalOpen] = createSignal(false)
  const open = () => props.open ?? localOpen()
  const pending = createMemo(
    () =>
      !!props.busy || props.parts.some((part) => part.state.status === "pending" || part.state.status === "running"),
  )
  const definition = createMemo(() => ToolGroupRegistry.get(props.group.type))
  const totalDuration = createMemo(() => computeToolGroupDuration(props.parts))
  const componentName = createMemo(() => definition()?.componentName ?? `${props.group.type}-tool-group`)

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
        <div data-component={`${componentName()}-trigger`}>
          <span
            data-slot={`${componentName()}-title`}
            class="min-w-0 flex items-center gap-2 text-14-medium text-text-strong"
          >
            <span data-slot={`${componentName()}-label`} class="shrink-0">
              <ToolStatusTitle
                active={pending()}
                activeText={definition()?.title.active(i18n) ?? ""}
                doneText={definition()?.title.done(i18n) ?? ""}
                split={false}
              />
            </span>
            <span
              data-slot={`${componentName()}-summary`}
              class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-normal text-text-base"
            >
              {definition()?.renderSummary({ parts: props.parts, i18n })}
            </span>
            <Show when={!pending() && totalDuration()}>
              <span data-slot={`${componentName()}-total-duration`}>{totalDuration()}</span>
            </Show>
          </span>
          <Collapsible.Arrow />
        </div>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <div data-component={`${componentName()}-list`}>
          <Index each={props.parts}>
            {(partAccessor, index) => {
              const itemRenderer = definition()?.renderItem
              if (itemRenderer) {
                return (
                  <div data-slot={`${componentName()}-item`}>
                    {itemRenderer({
                      part: partAccessor(),
                      index,
                      parts: props.parts,
                      i18n,
                      message: props.message,
                      showAssistantCopyPartID: props.showAssistantCopyPartID,
                      turnDurationMs: props.turnDurationMs,
                      shellToolDefaultOpen: props.shellToolDefaultOpen,
                      editToolDefaultOpen: props.editToolDefaultOpen,
                      onCompactHere: props.onCompactHere,
                    })}
                  </div>
                )
              }

              if (props.renderFallbackItem) {
                return (
                  <div data-slot={`${componentName()}-item`}>
                    {props.renderFallbackItem({
                      part: partAccessor(),
                      message: props.message,
                      showAssistantCopyPartID: props.showAssistantCopyPartID,
                      turnDurationMs: props.turnDurationMs,
                      shellToolDefaultOpen: props.shellToolDefaultOpen,
                      editToolDefaultOpen: props.editToolDefaultOpen,
                      onCompactHere: props.onCompactHere,
                    })}
                  </div>
                )
              }

              return null
            }}
          </Index>
        </div>
      </Collapsible.Content>
    </Collapsible>
  )
}

export function ContextToolGroup(props: {
  parts: ToolPart[]
  busy?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onSizeChange?: () => void
}) {
  const group = createMemo(() => ({
    key: `context:${props.parts[0]?.id ?? "0"}`,
    type: "context",
    refs: props.parts.map((p) => ({ messageID: p.sessionID, partID: p.id })),
  }))
  return <GenericToolGroup group={group()} {...props} />
}

export function PythonToolGroup(props: {
  parts: ToolPart[]
  message?: AssistantMessage
  busy?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onSizeChange?: () => void
  shellToolDefaultOpen?: boolean
  editToolDefaultOpen?: boolean
  showAssistantCopyPartID?: string | null
  turnDurationMs?: number
  renderFallbackItem?: (props: any) => JSX.Element
}) {
  const group = createMemo(() => ({
    key: `python:${props.parts[0]?.id ?? "0"}`,
    type: "python",
    refs: props.parts.map((p) => ({ messageID: p.sessionID, partID: p.id })),
  }))
  return <GenericToolGroup group={group()} {...props} />
}
