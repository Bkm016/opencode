import gsap from "gsap"
import { createMemo, onCleanup, Show, type Accessor, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { ContextMenu } from "@opencode-ai/ui/context-menu"
import { createSortable } from "@thisbeyond/solid-dnd"
import { useLayout, type LocalProject } from "@/context/layout"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { prefersReducedMotion } from "@/utils/gsap-motion"
import { ProjectIcon } from "./sidebar-items"
import { displayName } from "./helpers"

export type ProjectSidebarContext = {
  currentProject: Accessor<LocalProject | undefined>
  navigateToProject: (directory: string) => void
  closeProject: (directory: string) => void
  showEditProjectDialog: (project: LocalProject) => void
  toggleProjectWorkspaces: (project: LocalProject) => void
  workspacesEnabled: (project: LocalProject) => boolean
  workspaceIds: (project: LocalProject) => string[]
}

export const ProjectDragOverlay = (props: {
  projects: Accessor<LocalProject[]>
  activeProject: Accessor<string | undefined>
}): JSX.Element => {
  const project = createMemo(() => props.projects().find((p) => p.worktree === props.activeProject()))
  return (
    <Show when={project()}>
      {(p) => (
        <div class="bg-background-base rounded-xl p-1">
          <ProjectIcon project={p()} />
        </div>
      )}
    </Show>
  )
}

const ProjectTile = (props: {
  project: LocalProject
  selected: Accessor<boolean>
  active: Accessor<boolean>
  isWorking: Accessor<boolean>
  dirs: Accessor<string[]>
  navigateToProject: (directory: string) => void
  showEditProjectDialog: (project: LocalProject) => void
  toggleProjectWorkspaces: (project: LocalProject) => void
  workspacesEnabled: (project: LocalProject) => boolean
  closeProject: (directory: string) => void
  setMenu: (value: boolean) => void
  language: ReturnType<typeof useLanguage>
}): JSX.Element => {
  const layout = useLayout()
  let icon: HTMLDivElement | undefined

  const animateHover = (active: boolean) => {
    if (!icon || prefersReducedMotion()) return
    gsap.to(icon, {
      scale: active ? 1.05 : 1,
      y: active ? -1 : 0,
      filter: active ? "brightness(1.12)" : "brightness(1)",
      duration: active ? 0.28 : 0.36,
      ease: active ? "power3.out" : "power3.inOut",
      overwrite: "auto",
    })
  }

  onCleanup(() => {
    if (icon) gsap.killTweensOf(icon)
  })

  return (
    <ContextMenu
      modal
      onOpenChange={(value) => {
        props.setMenu(value)
      }}
    >
      <ContextMenu.Trigger
        as="button"
        type="button"
        aria-label={displayName(props.project)}
        data-action="project-switch"
        data-project={base64Encode(props.project.worktree)}
        data-selected={props.selected() ? "true" : undefined}
        classList={{
          "relative z-10 flex items-center justify-center size-10 p-1 rounded-lg overflow-hidden transition-colors cursor-default focus:outline-none": true,
          "bg-surface-base-hover": !props.selected() && props.active(),
        }}
        onClick={() => {
          if (props.selected()) {
            layout.sidebar.toggle()
            return
          }
          props.navigateToProject(props.project.worktree)
        }}
        onMouseEnter={() => animateHover(true)}
        onMouseLeave={() => animateHover(false)}
        onFocus={() => animateHover(true)}
        onBlur={() => animateHover(false)}
      >
        <div
          ref={(element) => {
            icon = element
            gsap.set(element, {
              scale: 1,
              y: 0,
              filter: "brightness(1)",
              transformOrigin: "center center",
            })
          }}
          class="flex size-full items-center justify-center will-change-transform"
        >
          <ProjectIcon project={props.project} notify working={props.isWorking()} />
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content>
          <ContextMenu.Item onSelect={() => props.showEditProjectDialog(props.project)}>
            <ContextMenu.ItemLabel>{props.language.t("common.edit")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Item
            data-action="project-workspaces-toggle"
            data-project={base64Encode(props.project.worktree)}
            disabled={props.project.vcs !== "git" && !props.workspacesEnabled(props.project)}
            onSelect={() => props.toggleProjectWorkspaces(props.project)}
          >
            <ContextMenu.ItemLabel>
              {props.workspacesEnabled(props.project)
                ? props.language.t("sidebar.workspaces.disable")
                : props.language.t("sidebar.workspaces.enable")}
            </ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Separator />
          <ContextMenu.Item
            data-action="project-close-menu"
            data-project={base64Encode(props.project.worktree)}
            onSelect={() => props.closeProject(props.project.worktree)}
          >
            <ContextMenu.ItemLabel>{props.language.t("common.close")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu>
  )
}

export const SortableProject = (props: {
  project: LocalProject
  ctx: ProjectSidebarContext
}): JSX.Element => {
  const serverSync = useServerSync()
  const language = useLanguage()
  const sortable = createSortable(props.project.worktree)
  const selected = createMemo(() => props.ctx.currentProject()?.worktree === props.project.worktree)
  const dirs = createMemo(() => props.ctx.workspaceIds(props.project))
  const [state, setState] = createStore({
    menu: false,
  })

  const active = createMemo(() => state.menu)

  const isWorking = createMemo(() =>
    dirs().some((directory) => {
      return Object.keys(serverSync().session.data.session_status).some((id) => {
        if (serverSync().session.get(id)?.directory !== directory) return false
        return serverSync().session.data.session_working(id)
      })
    }),
  )

  return (
    // @ts-ignore
    <div use:sortable classList={{ "opacity-30": sortable.isActiveDraggable }}>
      <ProjectTile
        project={props.project}
        selected={selected}
        active={active}
        isWorking={isWorking}
        dirs={dirs}
        navigateToProject={props.ctx.navigateToProject}
        showEditProjectDialog={props.ctx.showEditProjectDialog}
        toggleProjectWorkspaces={props.ctx.toggleProjectWorkspaces}
        workspacesEnabled={props.ctx.workspacesEnabled}
        closeProject={props.ctx.closeProject}
        setMenu={(value) => setState("menu", value)}
        language={language}
      />
    </div>
  )
}
