import { createEffect, createMemo, For, onCleanup, onMount, Show, type Accessor, type JSX } from "solid-js"
import gsap from "gsap"
import {
  DragDropProvider,
  DragDropSensors,
  DragOverlay,
  SortableProvider,
  closestCenter,
  type DragEvent,
} from "@thisbeyond/solid-dnd"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { ConstrainDragXAxis } from "@/utils/solid-dnd"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { type LocalProject } from "@/context/layout"
import { prefersReducedMotion } from "@/utils/gsap-motion"

export const SidebarContent = (props: {
  mobile?: boolean
  opened: Accessor<boolean>
  projects: Accessor<LocalProject[]>
  currentProject: Accessor<LocalProject | undefined>
  renderProject: (project: LocalProject) => JSX.Element
  handleDragStart: (event: unknown) => void
  handleDragEnd: () => void
  handleDragOver: (event: DragEvent) => void
  openProjectLabel: JSX.Element
  openProjectKeybind: Accessor<string | undefined>
  onOpenProject: () => void
  renderProjectOverlay: () => JSX.Element
  settingsLabel: Accessor<string>
  settingsKeybind: Accessor<string | undefined>
  onOpenSettings: () => void
  renderPanel: () => JSX.Element
}): JSX.Element => {
  const expanded = createMemo(() => !!props.mobile || props.opened())
  const placement = () => (props.mobile ? "bottom" : "right")
  let stage: HTMLDivElement | undefined
  let rail: HTMLDivElement | undefined
  let selection: HTMLDivElement | undefined
  // 窗口 resize 期间禁用 selection 补间：拖动会让列表反复重排，GSAP 每次补间
  // 都 getComputedStyle 读 transform 强制同步布局，几十个补间叠加直接卡死主线程。
  let resizing = false
  let resizeTimer: ReturnType<typeof setTimeout> | undefined

  onMount(() => {
    const onResize = () => {
      resizing = true
      if (selection) gsap.killTweensOf(selection)
      if (resizeTimer !== undefined) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        resizing = false
        resizeTimer = undefined
        // resize 结束后补一次定位，恢复 selection 到正确位置。
        moveSelection()
      }, 150)
    }
    window.addEventListener("resize", onResize)
    onCleanup(() => {
      window.removeEventListener("resize", onResize)
      if (resizeTimer !== undefined) clearTimeout(resizeTimer)
    })
  })
  let frame: number | undefined
  let restoreFrame: number | undefined
  let scrollTop = 0
  let pendingProjectScroll: { project: string; top: number } | undefined
  // 记录上一次应用的 selection 目标，相同目标直接短路，避免高频触发时反复
  // kill+重建 GSAP tween（每次 init 都 getComputedStyle 强制布局，形成自激振荡）。
  let lastSelectionKey: string | undefined

  const moveSelection = () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      frame = undefined
      // resize 期间跳过布局读取：列表正反复重排，此时 getBoundingClientRect 会
      // 强制同步布局，等 resize 结束（resizing 复位）后由下一次触发重新定位。
      if (resizing) return
      if (!stage || !rail || !selection) return

      const target = rail.querySelector<HTMLElement>('[data-action="project-switch"][data-selected="true"]')
      if (!target) {
        // 选中项已隐藏，仅当之前不是隐藏态时才补间到 opacity 0，避免重复 tween。
        if (lastSelectionKey === "hidden") return
        lastSelectionKey = "hidden"
        gsap.to(selection, { opacity: 0, duration: 0.16, overwrite: "auto" })
        return
      }

      const stageRect = stage.getBoundingClientRect()
      const targetRect = target.getBoundingClientRect()
      const values = {
        left: targetRect.left - stageRect.left,
        top: targetRect.top - stageRect.top,
        width: target.offsetWidth,
        height: target.offsetHeight,
        opacity: 1,
      }
      // 目标位置未变化时不重复补间。
      const key = `${values.left},${values.top},${values.width},${values.height}`
      if (key === lastSelectionKey) return
      lastSelectionKey = key
      // resize 期间瞬时定位，避免补间读 transform 触发 layout thrashing。
      if (resizing || prefersReducedMotion()) {
        gsap.set(selection, values)
        return
      }
      gsap.to(selection, {
        ...values,
        duration: 0.26,
        ease: "power3.out",
        overwrite: "auto",
      })
    })
  }

  createEffect(() => {
    const currentProject = props.currentProject()?.worktree
    props.projects()
    if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame)
    const pending = pendingProjectScroll?.project === base64Encode(currentProject ?? "") ? pendingProjectScroll : undefined
    const top = pending?.top ?? scrollTop
    restoreFrame = requestAnimationFrame(() => {
      if (!rail) return
      // 路由更新会重置滚动容器，连续两帧恢复点击项目时的位置。
      rail.scrollTop = top
      restoreFrame = requestAnimationFrame(() => {
        restoreFrame = undefined
        if (!rail) return
        rail.scrollTop = top
        if (pending) pendingProjectScroll = undefined
      })
    })
    moveSelection()
  })

  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame)
    if (selection) gsap.killTweensOf(selection)
  })

  return (
    <div class="flex h-full w-full min-w-0 overflow-hidden">
      <div
        data-component="sidebar-rail"
        class="w-16 shrink-0 bg-background-base flex flex-col items-center overflow-hidden"
      >
        <div class="flex-1 min-h-0 w-full">
          <DragDropProvider
            onDragStart={props.handleDragStart}
            onDragEnd={props.handleDragEnd}
            onDragOver={props.handleDragOver}
            collisionDetector={closestCenter}
          >
            <DragDropSensors />
            <ConstrainDragXAxis />
            <div
              ref={(element) => {
                stage = element
              }}
              class="relative h-full w-full"
            >
              <div
                ref={(element) => {
                  rail = element
                }}
                class="h-full w-full flex flex-col items-center gap-3 px-3 py-3 overflow-y-auto no-scrollbar"
                onPointerDown={(event) => {
                  const target = event.target as HTMLElement
                  const project = target.closest<HTMLElement>('[data-action="project-switch"]')?.dataset.project
                  if (!project) return
                  pendingProjectScroll = { project, top: event.currentTarget.scrollTop }
                }}
                onScroll={(event) => {
                  scrollTop = event.currentTarget.scrollTop
                  moveSelection()
                }}
              >
                <SortableProvider ids={props.projects().map((p) => p.worktree)}>
                  <For each={props.projects()}>{(project) => props.renderProject(project)}</For>
                </SortableProvider>
                <Tooltip
                  placement={placement()}
                  value={
                    <div class="flex items-center gap-2">
                      <span>{props.openProjectLabel}</span>
                      <Show when={!props.mobile && !!props.openProjectKeybind()}>
                        <span class="text-icon-base text-12-medium">{props.openProjectKeybind()}</span>
                      </Show>
                    </div>
                  }
                >
                  <IconButton
                    icon="plus"
                    variant="ghost"
                    size="large"
                    onClick={props.onOpenProject}
                    aria-label={typeof props.openProjectLabel === "string" ? props.openProjectLabel : undefined}
                  />
                </Tooltip>
              </div>
              <div
                ref={(element) => {
                  selection = element
                }}
                aria-hidden="true"
                class="pointer-events-none absolute left-0 top-0 z-0 rounded-lg border-2 border-icon-strong-base opacity-0"
              />
            </div>
            <DragOverlay>{props.renderProjectOverlay()}</DragOverlay>
          </DragDropProvider>
        </div>
        <div class="shrink-0 w-full pt-3 pb-6 flex flex-col items-center gap-2">
          <TooltipKeybind placement={placement()} title={props.settingsLabel()} keybind={props.settingsKeybind() ?? ""}>
            <IconButton
              icon="settings-gear"
              variant="ghost"
              size="large"
              onClick={props.onOpenSettings}
              aria-label={props.settingsLabel()}
            />
          </TooltipKeybind>
        </div>
      </div>

      <Show when={expanded()}>
        <div class="flex-1 flex h-full min-h-0 min-w-0 overflow-hidden">{props.renderPanel()}</div>
      </Show>
    </div>
  )
}
