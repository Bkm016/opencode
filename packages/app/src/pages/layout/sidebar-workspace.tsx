import { useNavigate, useParams } from "@solidjs/router"
import { createEffect, createMemo, For, Show, type Accessor, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { createSortable } from "@thisbeyond/solid-dnd"
import { createMediaQuery } from "@solid-primitives/media"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { getFilename } from "@opencode-ai/core/util/path"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { type Session } from "@opencode-ai/sdk/v2/client"
import { type LocalProject } from "@/context/layout"
import { useServerSync, useQueryOptions } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { pathKey } from "@/utils/path-key"
import { SessionItem, SessionSkeleton } from "./sidebar-items"
import { isSessionPinned, pinnedSessionIds } from "@/utils/session-pin"
import { sessionGroupOpen, setSessionGroupOpen } from "@/utils/session-groups"
import { sortedRootSessions } from "./helpers"
import { useIsFetching } from "@tanstack/solid-query"

type InlineEditorComponent = (props: {
  id: string
  value: Accessor<string>
  onSave: (next: string) => void
  class?: string
  displayClass?: string
  editing?: boolean
  stopPropagation?: boolean
  openOnDblClick?: boolean
}) => JSX.Element

type SessionGroup = {
  key: string
  label?: string
  sessions: Session[]
  collapsible: boolean
  defaultOpen: boolean
}

export type WorkspaceSidebarContext = {
  currentDir: Accessor<string>
  navList: Accessor<Session[]>
  sidebarExpanded: Accessor<boolean>
  sidebarHovering: Accessor<boolean>
  prefetchSession: (session: Session, priority?: "high" | "low") => void
  archiveSession: (session: Session) => Promise<void>
  workspaceName: (directory: string, projectId?: string, branch?: string) => string | undefined
  renameWorkspace: (directory: string, next: string, projectId?: string, branch?: string) => void
  editorOpen: (id: string) => boolean
  openEditor: (id: string, value: string) => void
  closeEditor: () => void
  setEditor: (key: "value", value: string) => void
  InlineEditor: InlineEditorComponent
  isBusy: (directory: string) => boolean
  workspaceExpanded: (directory: string, local: boolean) => boolean
  setWorkspaceExpanded: (directory: string, value: boolean) => void
  showResetWorkspaceDialog: (root: string, directory: string) => void
  showDeleteWorkspaceDialog: (root: string, directory: string) => void
  setScrollContainerRef: (el: HTMLDivElement | undefined, mobile?: boolean) => void
  sessionGroupsCommand: Accessor<{ open: boolean; revision: number } | undefined>
}

export const WorkspaceDragOverlay = (props: {
  sidebarProject: Accessor<LocalProject | undefined>
  activeWorkspace: Accessor<string | undefined>
  workspaceLabel: (directory: string, branch?: string, projectId?: string) => string
}): JSX.Element => {
  const serverSync = useServerSync()
  const language = useLanguage()
  const label = createMemo(() => {
    const project = props.sidebarProject()
    if (!project) return
    const directory = props.activeWorkspace()
    if (!directory) return

    const kind =
      directory === project.worktree ? language.t("workspace.type.local") : language.t("workspace.type.sandbox")
    const name = props.workspaceLabel(directory, undefined, project.id)
    return `${kind} : ${name}`
  })

  return (
    <Show when={label()}>
      {(value) => <div class="bg-background-base rounded-md px-2 py-1 text-14-medium text-text-strong">{value()}</div>}
    </Show>
  )
}

const WorkspaceHeader = (props: {
  local: Accessor<boolean>
  busy: Accessor<boolean>
  open: Accessor<boolean>
  directory: string
  language: ReturnType<typeof useLanguage>
  branch: Accessor<string | undefined>
  workspaceValue: Accessor<string>
  workspaceEditActive: Accessor<boolean>
  InlineEditor: WorkspaceSidebarContext["InlineEditor"]
  renameWorkspace: WorkspaceSidebarContext["renameWorkspace"]
  setEditor: WorkspaceSidebarContext["setEditor"]
  projectId?: string
}): JSX.Element => (
  <div class="flex items-center gap-1 min-w-0 flex-1">
    <div class="flex items-center justify-center shrink-0 size-6">
      <Show when={props.busy()} fallback={<Icon name="branch" size="small" />}>
        <Spinner class="size-[15px]" />
      </Show>
    </div>
    <span class="text-14-medium text-text-base shrink-0">
      {props.local() ? props.language.t("workspace.type.local") : props.language.t("workspace.type.sandbox")} :
    </span>
    <Show
      when={!props.local()}
      fallback={
        <span class="text-14-medium text-text-base min-w-0 truncate">
          {props.branch() ?? getFilename(props.directory)}
        </span>
      }
    >
      <props.InlineEditor
        id={`workspace:${props.directory}`}
        value={props.workspaceValue}
        onSave={(next) => {
          const trimmed = next.trim()
          if (!trimmed) return
          props.renameWorkspace(props.directory, trimmed, props.projectId, props.branch())
          props.setEditor("value", props.workspaceValue())
        }}
        class="text-14-medium text-text-base min-w-0 truncate"
        displayClass="text-14-medium text-text-base min-w-0 truncate"
        editing={props.workspaceEditActive()}
        stopPropagation={false}
        openOnDblClick={false}
      />
    </Show>
    <div class="flex items-center justify-center shrink-0 overflow-hidden w-0 opacity-0 transition-all duration-200 group-hover/workspace:w-3.5 group-hover/workspace:opacity-100 group-focus-within/workspace:w-3.5 group-focus-within/workspace:opacity-100">
      <Icon name={props.open() ? "chevron-down" : "chevron-right"} size="small" class="text-icon-base" />
    </div>
  </div>
)

const WorkspaceActions = (props: {
  directory: string
  local: Accessor<boolean>
  busy: Accessor<boolean>
  menuOpen: Accessor<boolean>
  pendingRename: Accessor<boolean>
  setMenuOpen: (open: boolean) => void
  setPendingRename: (value: boolean) => void
  sidebarHovering: Accessor<boolean>
  touch: Accessor<boolean>
  language: ReturnType<typeof useLanguage>
  workspaceValue: Accessor<string>
  openEditor: WorkspaceSidebarContext["openEditor"]
  showResetWorkspaceDialog: WorkspaceSidebarContext["showResetWorkspaceDialog"]
  showDeleteWorkspaceDialog: WorkspaceSidebarContext["showDeleteWorkspaceDialog"]
  root: string
  navigateToNewSession: () => void
}): JSX.Element => (
  <div
    class="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 transition-opacity"
    classList={{
      "opacity-100 pointer-events-auto": props.menuOpen() || props.touch(),
      "opacity-0 pointer-events-none": !props.menuOpen() && !props.touch(),
      "group-hover/workspace:opacity-100 group-hover/workspace:pointer-events-auto": true,
      "group-focus-within/workspace:opacity-100 group-focus-within/workspace:pointer-events-auto": true,
    }}
  >
    <DropdownMenu
      modal={!props.sidebarHovering()}
      open={props.menuOpen()}
      onOpenChange={(open) => props.setMenuOpen(open)}
    >
      <Tooltip value={props.language.t("common.moreOptions")} placement="top">
        <DropdownMenu.Trigger
          as={IconButton}
          icon="dot-grid"
          variant="ghost"
          class="size-6 rounded-md"
          data-action="workspace-menu"
          data-workspace={base64Encode(props.directory)}
          aria-label={props.language.t("common.moreOptions")}
          disabled={props.busy()}
        />
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          onCloseAutoFocus={(event) => {
            if (!props.pendingRename()) return
            event.preventDefault()
            props.setPendingRename(false)
            props.openEditor(`workspace:${props.directory}`, props.workspaceValue())
          }}
        >
          <DropdownMenu.Item
            disabled={props.local()}
            onSelect={() => {
              props.setPendingRename(true)
              props.setMenuOpen(false)
            }}
          >
            <DropdownMenu.ItemLabel>{props.language.t("common.rename")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            disabled={props.local() || props.busy()}
            onSelect={() => props.showResetWorkspaceDialog(props.root, props.directory)}
          >
            <DropdownMenu.ItemLabel>{props.language.t("common.reset")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            disabled={props.local() || props.busy()}
            onSelect={() => props.showDeleteWorkspaceDialog(props.root, props.directory)}
          >
            <DropdownMenu.ItemLabel>{props.language.t("common.delete")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
    <Show when={!props.touch()}>
      <Tooltip value={props.language.t("command.session.new")} placement="top">
        <IconButtonV2
          icon={<IconV2 name="edit" size="small" />}
          variant="ghost"
          size="small"
          class="size-6 rounded-md opacity-0 pointer-events-none group-hover/workspace:opacity-100 group-hover/workspace:pointer-events-auto group-focus-within/workspace:opacity-100 group-focus-within/workspace:pointer-events-auto"
          data-action="workspace-new-session"
          data-workspace={base64Encode(props.directory)}
          aria-label={props.language.t("command.session.new")}
          disabled={props.busy()}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            props.navigateToNewSession()
          }}
        />
      </Tooltip>
    </Show>
  </div>
)

export const WorkspaceSessionList = (props: {
  slug: Accessor<string>
  mobile?: boolean
  ctx: WorkspaceSidebarContext
  loading: Accessor<boolean>
  sessions: Accessor<Session[]>
  /** 聊天区专用：不分组，直接平铺全部会话。 */
  flat?: boolean
  /** 聊天区专用：不显示空态 placeholder。 */
  hideEmpty?: boolean
}): JSX.Element => {
  const params = useParams()
  const language = useLanguage()
  // 分组折叠默认全收起，展开状态按侧栏列表 scope 持久化记忆，刷新后仍生效。
  // 挂载时记录当前命令版本，避免把挂载前的一次性折叠/展开命令重复套用到新列表上。
  const initialCommand = props.ctx.sessionGroupsCommand()
  let groupCommandRevision = initialCommand?.revision ?? 0

  const isGroupOpen = (group: SessionGroup) => sessionGroupOpen(props.slug(), group.key) ?? group.defaultOpen

  const setGroupExpanded = (group: SessionGroup, open: boolean) => {
    setSessionGroupOpen(props.slug(), group.key, open)
  }

  const groups = createMemo(() => {
    const groups: SessionGroup[] = []
    // 置顶会话集中在最前的“置顶”分组，跟时间分区走同一条渲染路径。
    const pinned = props.sessions().filter((session) => isSessionPinned(session.directory, session.id))
    if (pinned.length > 0) {
      groups.push({
        key: "pinned",
        label: language.t("home.sessions.group.pinned"),
        sessions: pinned,
        collapsible: true,
        defaultOpen: false,
      })
    }

    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const oneDay = 24 * 60 * 60 * 1000
    props
      .sessions()
      .filter((session) => !isSessionPinned(session.directory, session.id))
      .forEach((session) => {
        const date = new Date(session.time.updated ?? session.time.created)
        const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
        // 今天的会话直接平铺，不加分组头、不参与折叠命令。
        if (day === today) {
          groups.push({ key: `flat-${session.id}`, sessions: [session], collapsible: false, defaultOpen: true })
          return
        }
        // 只保留昨天 / 前天 / 三天前三档，四天及以上统一归入“七天前”。
        const daysAgo = Math.round((today - day) / oneDay)
        const label =
          daysAgo === 1
            ? language.t("home.sessions.group.yesterday")
            : daysAgo === 2
              ? language.t("home.sessions.group.dayBeforeYesterday")
              : daysAgo === 3
                ? language.t("home.sessions.group.threeDaysAgo")
                : language.t("home.sessions.group.sevenDaysAgo")
        const key = daysAgo <= 3 ? String(day) : "older"
        const group = groups.at(-1)
        if (group?.key === key) {
          group.sessions.push(session)
          return
        }
        groups.push({
          key,
          label,
          sessions: [session],
          collapsible: true,
          defaultOpen: false,
        })
      })
    return groups
  })
  createEffect(() => {
    const command = props.ctx.sessionGroupsCommand()
    if (!command || command.revision === groupCommandRevision) return
    groupCommandRevision = command.revision
    for (const group of groups()) {
      if (group.collapsible) setSessionGroupOpen(props.slug(), group.key, command.open)
    }
  })

  // 路由指向某个会话时，自动展开包含该会话的分组（只在路由变化时执行一次，不持续监听）。
  let lastAutoExpandedSession: string | undefined
  createEffect(() => {
    const sessionID = params.id
    if (!sessionID) return
    if (sessionID === lastAutoExpandedSession) return
    lastAutoExpandedSession = sessionID
    const group = groups().find((item) => item.sessions.some((session) => session.id === sessionID))
    if (!group) return
    if (!isGroupOpen(group)) setSessionGroupOpen(props.slug(), group.key, true)
  })
  const item = (session: Session) => (
    <SessionItem
      session={session}
      list={props.sessions()}
      navList={props.ctx.navList}
      slug={props.slug()}
      mobile={props.mobile}
      showChild
      sidebarExpanded={props.ctx.sidebarExpanded}
      prefetchSession={props.ctx.prefetchSession}
      archiveSession={props.ctx.archiveSession}
    />
  )
  const sessionItems = (sessions: Session[]) => (
    <div class="flex flex-col gap-1">
      <For each={sessions}>{item}</For>
    </div>
  )

  return (
    <nav class="flex flex-1 flex-col gap-1">
      <Show when={props.loading()}>
        <SessionSkeleton />
      </Show>
      <Show when={!props.hideEmpty && !props.loading() && props.sessions().length === 0}>
        <div
          data-component="sessions-empty"
          class="relative flex min-h-48 flex-1 items-center justify-center px-6 text-center"
        >
          <svg
            aria-hidden="true"
            class="pointer-events-none absolute -top-1 right-[3.7rem] h-16 w-8 text-icon-weaker opacity-60"
            viewBox="0 0 32 64"
          >
            <path
              d="M16 58V7"
              fill="none"
              stroke="currentColor"
              stroke-width="1.25"
              stroke-linecap="round"
              vector-effect="non-scaling-stroke"
            />
            <path
              d="M10 14L16 7L22 14"
              fill="none"
              stroke="currentColor"
              stroke-width="1.25"
              stroke-linecap="round"
              stroke-linejoin="round"
              vector-effect="non-scaling-stroke"
            />
          </svg>
          <div class="relative z-10 flex max-w-56 flex-col gap-1">
            <div class="text-13-medium text-text-base">{language.t("home.sessions.empty")}</div>
            <div class="text-12-regular text-text-weak">{language.t("home.sessions.empty.description")}</div>
          </div>
        </div>
      </Show>
      <Show
        when={!props.mobile}
        fallback={sessionItems(props.sessions())}
      >
        <Show when={props.flat} fallback={
          <For each={groups()}>
            {(group) => (
              <Show when={group.collapsible} fallback={sessionItems(group.sessions)}>
                <div class="mt-0.5 flex flex-col gap-0.5 first:mt-0">
                  <div
                    role="button"
                    tabIndex={0}
                    aria-expanded={isGroupOpen(group)}
                    onClick={() => setGroupExpanded(group, !isGroupOpen(group))}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault()
                        setGroupExpanded(group, !isGroupOpen(group))
                      }
                    }}
                    class="flex h-7 cursor-pointer items-center justify-between px-2 text-text-weak/50 hover:text-text-base focus-visible:outline-none focus-visible:bg-surface-raised-base-hover"
                  >
                    <span>{group.label}</span>
                    <span class="flex items-center gap-1">
                      <span class="text-11-regular text-text-weaker">{group.sessions.length}</span>
                      <Icon
                        name="chevron-down"
                        size="small"
                        class="shrink-0 text-icon-weaker transition-transform duration-150"
                        classList={{ "rotate-180": !isGroupOpen(group) }}
                      />
                    </span>
                  </div>
                  <div class="sidebar-reveal" data-open={isGroupOpen(group) ? "" : undefined}>
                    <div class="sidebar-reveal-inner">
                      {sessionItems(group.sessions)}
                    </div>
                  </div>
                </div>
              </Show>
            )}
          </For>
        }>
          {sessionItems(props.sessions())}
        </Show>
      </Show>
    </nav>
  )
}

export const SortableWorkspace = (props: {
  ctx: WorkspaceSidebarContext
  directory: string
  project: LocalProject
  sortNow: Accessor<number>
  mobile?: boolean
}): JSX.Element => {
  const navigate = useNavigate()
  const serverSync = useServerSync()
  const queryOptions = useQueryOptions()
  const language = useLanguage()
  const sortable = createSortable(props.directory)
  const [workspaceStore] = serverSync().child(props.directory, { bootstrap: false })
  const [menu, setMenu] = createStore({
    open: false,
    pendingRename: false,
  })
  const slug = createMemo(() => base64Encode(props.directory))
  const sessions = createMemo(() =>
    sortedRootSessions(workspaceStore, props.sortNow(), pinnedSessionIds(props.directory)),
  )
  const local = createMemo(() => props.directory === props.project.worktree)
  const active = createMemo(() => pathKey(props.ctx.currentDir()) === pathKey(props.directory))
  const workspaceValue = createMemo(() => {
    const name = getFilename(props.directory)
    return props.ctx.workspaceName(props.directory, props.project.id, undefined) ?? name
  })
  const open = createMemo(() => props.ctx.workspaceExpanded(props.directory, local()))
  const boot = createMemo(() => open() || active())
  const count = createMemo(() => sessions()?.length ?? 0)
  const fetching = useIsFetching(() => queryOptions().sessions(pathKey(props.directory)))
  const busy = createMemo(() => props.ctx.isBusy(props.directory))
  const loading = () => fetching() > 0 && count() === 0
  const touch = createMediaQuery("(hover: none)")

  const workspaceEditActive = createMemo(() => props.ctx.editorOpen(`workspace:${props.directory}`))
  const header = () => (
    <WorkspaceHeader
      local={local}
      busy={busy}
      open={open}
      directory={props.directory}
      language={language}
      branch={() => undefined}
      workspaceValue={workspaceValue}
      workspaceEditActive={workspaceEditActive}
      InlineEditor={props.ctx.InlineEditor}
      renameWorkspace={props.ctx.renameWorkspace}
      setEditor={props.ctx.setEditor}
      projectId={props.project.id}
    />
  )

  const openWrapper = (value: boolean) => {
    props.ctx.setWorkspaceExpanded(props.directory, value)
    if (value) return
    if (props.ctx.editorOpen(`workspace:${props.directory}`)) props.ctx.closeEditor()
  }

  createEffect(() => {
    if (!boot()) return
    serverSync().child(props.directory, { bootstrap: true })
  })

  return (
    <div
      // @ts-ignore
      use:sortable
      classList={{
        "opacity-30": sortable.isActiveDraggable,
        "opacity-50": busy(),
      }}
    >
      <div class="shrink-0">
        <div class="py-1">
          <div
            class="group/workspace relative"
            data-component="workspace-item"
            data-workspace={base64Encode(props.directory)}
          >
            <div class="flex items-center gap-1">
              <Show
                when={workspaceEditActive()}
                fallback={
                  <div
                    role="button"
                    tabIndex={0}
                    aria-expanded={open()}
                    onClick={() => openWrapper(!open())}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault()
                        openWrapper(!open())
                      }
                    }}
                    class={`flex items-center justify-between w-full pl-2 py-1.5 rounded-md hover:bg-surface-raised-base-hover transition-[padding] duration-200 cursor-pointer ${
                      menu.open ? "pr-16" : "pr-2"
                    } group-hover/workspace:pr-16 group-focus-within/workspace:pr-16`}
                    data-action="workspace-toggle"
                    data-workspace={base64Encode(props.directory)}
                  >
                    {header()}
                    <Icon
                      name="chevron-down"
                      size="small"
                      class="shrink-0 text-icon-weaker transition-transform duration-150"
                      classList={{ "rotate-180": !open() }}
                    />
                  </div>
                }
              >
                <div
                  class={`flex items-center justify-between w-full pl-2 py-1.5 rounded-md transition-[padding] duration-200 ${
                    menu.open ? "pr-16" : "pr-2"
                  } group-hover/workspace:pr-16 group-focus-within/workspace:pr-16`}
                >
                  {header()}
                </div>
              </Show>
              <WorkspaceActions
                directory={props.directory}
                local={local}
                busy={busy}
                menuOpen={() => menu.open}
                pendingRename={() => menu.pendingRename}
                setMenuOpen={(open) => setMenu("open", open)}
                setPendingRename={(value) => setMenu("pendingRename", value)}
                sidebarHovering={props.ctx.sidebarHovering}
                touch={touch}
                language={language}
                workspaceValue={workspaceValue}
                openEditor={props.ctx.openEditor}
                showResetWorkspaceDialog={props.ctx.showResetWorkspaceDialog}
                showDeleteWorkspaceDialog={props.ctx.showDeleteWorkspaceDialog}
                root={props.project.worktree}
                navigateToNewSession={() => navigate(`/${slug()}/session`)}
              />
            </div>
          </div>
        </div>

        <Show when={open()}>
          <WorkspaceSessionList
            slug={slug}
            mobile={props.mobile}
            ctx={props.ctx}
            loading={loading}
            sessions={sessions}
          />
        </Show>
      </div>
    </div>
  )
}
