import { useNavigate } from "@solidjs/router"
import { For, Show, createMemo, type Accessor, type JSX } from "solid-js"
import { useQueryOptions, useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { base64Encode } from "@opencode-ai/core/util/encode"
import {
  DragDropProvider,
  DragDropSensors,
  DragOverlay,
  SortableProvider,
  closestCenter,
  createSortable,
  type DragEvent,
} from "@thisbeyond/solid-dnd"
import { useIsFetching } from "@tanstack/solid-query"
import { createMediaQuery } from "@solid-primitives/media"
import { type LocalProject } from "@/context/layout"
import { pathKey } from "@/utils/path-key"
import { pinnedSessionIds } from "@/utils/session-pin"
import { sessionTitle } from "@/utils/session-title"
import { ConstrainDragXAxis } from "@/utils/solid-dnd"
import {
  SortableWorkspace,
  WorkspaceDragOverlay,
  WorkspaceSessionList,
  type WorkspaceSidebarContext,
} from "./sidebar-workspace"
import { displayName, sortedRootSessions } from "./helpers"

export type ProjectSidebarContext = {
  currentProject: Accessor<LocalProject | undefined>
  navigateToProject: (directory: string) => void
  closeProject: (directory: string) => void
  showEditProjectDialog: (project: LocalProject) => void
  toggleProjectWorkspaces: (project: LocalProject) => void
  workspacesEnabled: (project: LocalProject) => boolean
  workspaceIds: (project: LocalProject) => string[]
}

export type TiledWorkspaceDrag = {
  onDragStart: (event: unknown) => void
  onDragOver: (event: DragEvent) => void
  onDragEnd: () => void
  activeWorkspace: Accessor<string | undefined>
  label: (directory: string, branch?: string, projectId?: string) => string
  onCreateWorkspace: (project: LocalProject) => void
}

// Codex 式平铺：各项目会话直接跟在项目下方，按置顶 + 今天平铺 + 昨天 / 日期分组展示。

export const ProjectDragOverlay = (props: {
  projects: Accessor<LocalProject[]>
  activeProject: Accessor<string | undefined>
}): JSX.Element => {
  const project = createMemo(() => props.projects().find((p) => p.worktree === props.activeProject()))
  return (
    <Show when={project()}>
      {(p) => (
        <div class="flex items-center gap-2 rounded-lg bg-background-base px-3 py-2 shadow-md">
          <Icon name="folder" size="small" class="shrink-0 text-icon-base" />
          <span class="text-14-medium text-text-strong">{displayName(p())}</span>
        </div>
      )}
    </Show>
  )
}

export const TiledProjectSection = (props: {
  project: LocalProject
  mobile?: boolean
  sortNow: Accessor<number>
  projectCtx: ProjectSidebarContext
  workspaceCtx: WorkspaceSidebarContext
  workspaceDrag: TiledWorkspaceDrag
  expanded: boolean
  onToggleExpanded: () => void
  onExpandAllGroups: () => void
  onCollapseAllGroups: () => void
}): JSX.Element => {
  const navigate = useNavigate()
  const language = useLanguage()
  const dialog = useDialog()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const queryOptions = useQueryOptions()
  const sortable = createSortable(props.project.worktree)
  const selected = createMemo(() => props.projectCtx.currentProject()?.worktree === props.project.worktree)
  const worktree = createMemo(() => props.project.worktree)
  const slug = createMemo(() => base64Encode(worktree()))
  const workspacesEnabled = createMemo(() => props.projectCtx.workspacesEnabled(props.project))
  const canToggle = createMemo(() => {
    if (props.project.vcs === "git") return true
    return props.projectCtx.workspacesEnabled(props.project)
  })
  const workspaces = createMemo(() => props.projectCtx.workspaceIds(props.project))
  const localChild = createMemo(() => {
    const [store] = serverSync().child(worktree(), { bootstrap: true })
    return { store }
  })
  const localSessions = createMemo(() =>
    sortedRootSessions(localChild().store, props.sortNow(), pinnedSessionIds(worktree())),
  )
  // 项目下任一 session 正在工作时显示指示点；仅统计已 bootstrap 的 local worktree，
  // workspace 子目录的状态由各自行的 busy spinner 负责。
  const hasWorking = createMemo(() => {
    const statuses = localChild().store.session_status
    return Object.values(statuses).some((s) => s.type !== "idle")
  })
  const localFetching = useIsFetching(() => queryOptions().sessions(pathKey(worktree())))
  // 触屏设备没有 hover，操作按钮常驻显示，否则用户无法新建会话或打开项目菜单。
  const touch = createMediaQuery("(hover: none)")
  const reveal = () =>
    touch()
      ? "size-6 rounded-md opacity-100 transition-opacity duration-150"
      : "size-6 rounded-md opacity-0 transition-opacity duration-150 pointer-events-none group-hover/project:opacity-100 group-hover/project:pointer-events-auto group-focus-within/project:opacity-100 group-focus-within/project:pointer-events-auto"
  // 首次加载（会话列表查询进行中或尚未发起）且会话为空时显示骨架屏；查询完成且为空时才显示空态。
  // 首次加载（child store 还在 loading/partial）且会话为空时显示骨架屏；加载完成（complete）且为空时才显示空态。
  const localLoading = () => (localSessions()?.length ?? 0) === 0 && localChild().store.status !== "complete"

  const openSkills = () => {
    const directory = worktree()
    if (!directory) return
    void import("@/components/dialog-skills").then((x) => {
      dialog.show(() => <x.DialogSkills directory={directory} />)
    })
  }
  const openInstructions = () => {
    const directory = worktree()
    if (!directory) return
    void import("@/components/settings-instructions").then((x) => {
      dialog.show(() => <x.DialogInstructions directory={directory} />)
    })
  }
  const openArchived = () => {
    const directory = worktree()
    if (!directory) return
    void import("@/components/dialog-archived-sessions").then((x) => {
      dialog.show(() => <x.DialogArchivedSessions directory={directory} project={props.project} />)
    })
  }
  // 换机迁移导入：选 transfer.json 恢复到本项目目录，成功后直接打开新会话。
  const importTransferBundle = () => {
    const directory = worktree()
    if (!directory) return
    const input = document.createElement("input")
    input.type = "file"
    input.accept = ".json,application/json"
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return
      void (async () => {
        try {
          const bundle = (await file.text().then((text) => JSON.parse(text))) as unknown
          const res = await serverSDK().client.session.import({
            sessionTransferBundle: bundle as never,
            directory,
          })
          if (res.error || !res.data) throw new Error("Failed to import session bundle")
          showToast({ variant: "success", title: language.t("session.import.toast.success.title") })
          navigate(`/${slug()}/session/${res.data.id}`)
        } catch (err) {
          showToast({
            variant: "error",
            title: language.t("session.import.toast.failed.title"),
            description: err instanceof Error ? err.message : String(err),
          })
        }
      })()
    }
    input.click()
  }

  return (
    // @ts-ignore
    <div use:sortable classList={{ "opacity-30": sortable.isActiveDraggable }}>
      <section data-component="tiled-project" data-project={slug()} class="min-w-0 rounded-lg">
        <div
          role="button"
          tabIndex={0}
          aria-expanded={props.expanded}
          data-action="project-collapse"
          data-project={slug()}
          title={worktree()}
          onClick={() => props.onToggleExpanded()}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault()
              props.onToggleExpanded()
            }
          }}
          class="group/project relative flex min-w-0 cursor-pointer items-center gap-1 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-raised-base-hover focus-visible:outline-none"
        >
          <Show when={selected()}>
            <div
              aria-hidden="true"
              class="pointer-events-none absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-icon-interactive-base"
            />
          </Show>
          <Icon name="folder" size="small" class="shrink-0 text-icon-base transition-transform duration-200 group-hover/project:scale-110" />
          <span class="min-w-0 flex-1 truncate text-14-medium text-text-strong">{displayName(props.project)}</span>
          <Show when={hasWorking()}>
            <div class="size-1.5 shrink-0 rounded-full bg-icon-interactive-base" />
          </Show>
          <div
            class="flex shrink-0 items-center"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <Tooltip value={language.t("command.session.new")} placement="top">
              <IconButton
                icon="plus"
                variant="ghost"
                size="small"
                class={reveal()}
                data-action="project-new-session"
                data-project={slug()}
                aria-label={language.t("command.session.new")}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  navigate(`/${slug()}/session`)
                }}
              />
            </Tooltip>
            <Tooltip value={language.t("home.sessions.group.expandAll")} placement="top">
              <IconButton
                icon="expand"
                variant="ghost"
                size="small"
                class={reveal()}
                data-action="sessions-expand-all"
                data-project={slug()}
                aria-label={language.t("home.sessions.group.expandAll")}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  props.onExpandAllGroups()
                }}
              />
            </Tooltip>
            <Tooltip value={language.t("home.sessions.group.collapseAll")} placement="top">
              <IconButton
                icon="collapse"
                variant="ghost"
                size="small"
                class={reveal()}
                data-action="sessions-collapse-all"
                data-project={slug()}
                aria-label={language.t("home.sessions.group.collapseAll")}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  props.onCollapseAllGroups()
                }}
              />
            </Tooltip>
            <DropdownMenu modal>
              <DropdownMenu.Trigger
                as={IconButton}
                icon="dot-grid"
                variant="ghost"
                data-action="project-menu"
                data-project={slug()}
                class={reveal() + " data-[expanded]:opacity-100 data-[expanded]:pointer-events-auto"}
                aria-label={language.t("common.moreOptions")}
              />
              <DropdownMenu.Portal>
                <DropdownMenu.Content class="mt-1">
                  <DropdownMenu.Item onSelect={() => props.projectCtx.showEditProjectDialog(props.project)}>
                    <DropdownMenu.ItemLabel>{language.t("common.edit")}</DropdownMenu.ItemLabel>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    data-action="project-workspaces-toggle"
                    data-project={slug()}
                    disabled={!canToggle()}
                    onSelect={() => props.projectCtx.toggleProjectWorkspaces(props.project)}
                  >
                    <DropdownMenu.ItemLabel>
                      {workspacesEnabled()
                        ? language.t("sidebar.workspaces.disable")
                        : language.t("sidebar.workspaces.enable")}
                    </DropdownMenu.ItemLabel>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item data-action="project-skills" data-project={slug()} onSelect={openSkills}>
                    <DropdownMenu.ItemLabel>{language.t("sidebar.project.skills")}</DropdownMenu.ItemLabel>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    data-action="project-instructions"
                    data-project={slug()}
                    onSelect={openInstructions}
                  >
                    <DropdownMenu.ItemLabel>{language.t("settings.tab.instructions")}</DropdownMenu.ItemLabel>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    data-action="project-archived-sessions"
                    data-project={slug()}
                    onSelect={openArchived}
                  >
                    <DropdownMenu.ItemLabel>{language.t("sidebar.project.archivedSessions")}</DropdownMenu.ItemLabel>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    data-action="project-import-transfer"
                    data-project={slug()}
                    onSelect={importTransferBundle}
                  >
                    <DropdownMenu.ItemLabel>{language.t("sidebar.project.importTransfer")}</DropdownMenu.ItemLabel>
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item
                    data-action="project-close-menu"
                    data-project={slug()}
                    onSelect={() => props.projectCtx.closeProject(worktree())}
                  >
                    <DropdownMenu.ItemLabel>{language.t("common.close")}</DropdownMenu.ItemLabel>
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu>
          </div>
        </div>

        <div class="sidebar-reveal" data-open={props.expanded ? "" : undefined}>
          <div class="sidebar-reveal-inner">
            <div class="min-w-0 pt-1 pb-1 pl-4 pr-4">
            <Show
              when={workspacesEnabled()}
              fallback={
                <WorkspaceSessionList
                  slug={slug}
                  mobile={props.mobile}
                  ctx={props.workspaceCtx}
                  loading={localLoading}
                  sessions={localSessions}
                />
              }
            >
              <div
                class="flex min-w-0 flex-col gap-1"
                onPointerDown={(event) => event.stopPropagation()}
              >
                <Button
                  size="large"
                  icon="plus-small"
                  class="w-full"
                  onClick={() => props.workspaceDrag.onCreateWorkspace(props.project)}
                >
                  {language.t("workspace.new")}
                </Button>
                <DragDropProvider
                  onDragStart={props.workspaceDrag.onDragStart}
                  onDragEnd={props.workspaceDrag.onDragEnd}
                  onDragOver={props.workspaceDrag.onDragOver}
                  collisionDetector={closestCenter}
                >
                  <DragDropSensors />
                  <ConstrainDragXAxis />
                  <SortableProvider ids={workspaces()}>
                    <div class="flex flex-col gap-2">
                      <For each={workspaces()}>
                        {(directory) => (
                          <SortableWorkspace
                            ctx={props.workspaceCtx}
                            directory={directory}
                            project={props.project}
                            sortNow={props.sortNow}
                            mobile={props.mobile}
                          />
                        )}
                      </For>
                    </div>
                  </SortableProvider>
                  <DragOverlay>
                    <WorkspaceDragOverlay
                      sidebarProject={() => props.project}
                      activeWorkspace={props.workspaceDrag.activeWorkspace}
                      workspaceLabel={props.workspaceDrag.label}
                    />
                  </DragOverlay>
                </DragDropProvider>
              </div>
            </Show>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
