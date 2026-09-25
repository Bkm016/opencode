import { For, Show, type Accessor, type JSX } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import {
  DragDropProvider,
  DragDropSensors,
  DragOverlay,
  SortableProvider,
  closestCenter,
  type DragEvent,
} from "@thisbeyond/solid-dnd"
import { ConstrainDragXAxis } from "@/utils/solid-dnd"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { type LocalProject } from "@/context/layout"

// Codex 式平铺侧栏：单列展示全部项目，各项目会话直接跟在项目下方，
// 不再使用左侧图标 rail 切换当前项目。
export const SidebarContent = (props: {
  mobile?: boolean
  projects: Accessor<LocalProject[]>
  renderProjectSection: (project: LocalProject) => JSX.Element
  handleDragStart: (event: unknown) => void
  handleDragEnd: () => void
  handleDragOver: (event: DragEvent) => void
  openProjectLabel: string
  openProjectKeybind: Accessor<string | undefined>
  onOpenProject: () => void
  expandAllLabel: string
  onExpandAll: () => void
  collapseAllLabel: string
  onCollapseAll: () => void
  renderProjectOverlay: () => JSX.Element
  settingsLabel: Accessor<string>
  settingsKeybind: Accessor<string | undefined>
  onOpenSettings: () => void
  headerTitle: string
  renderChat?: () => JSX.Element
  renderSearch?: () => JSX.Element
  renderEmpty: () => JSX.Element
  renderGettingStarted: () => JSX.Element
  setScrollRef: (el: HTMLDivElement | undefined) => void
}): JSX.Element => {
  const placement = () => (props.mobile ? "bottom" : "right")
  // 触屏设备没有 hover，项目栏操作按钮常驻显示，否则移动端无法打开项目入口。
  const touch = createMediaQuery("(hover: none)")
  return (
    <div class="flex h-full w-full min-w-0 flex-col overflow-hidden bg-background-base">
      {/* 聊天区在项目拖拽排序容器之外渲染，避免展开/收起触发项目排序引擎的 layout 测量。 */}
      <Show when={props.renderChat}>{(render) => <div class="flex shrink-0 flex-col px-2 pt-3">{render()()}</div>}</Show>

      <div class="group/sidebar-top flex shrink-0 items-center justify-between gap-2 px-3 pt-4 pb-2">
        <span class="min-w-0 flex-1 truncate px-2 text-13-medium text-text-weaker">{props.headerTitle}</span>
        <div
          class="flex shrink-0 items-center transition-opacity duration-150"
          classList={{
            "opacity-100": touch(),
            "opacity-0 pointer-events-none group-hover/sidebar-top:opacity-100 group-hover/sidebar-top:pointer-events-auto group-focus-within/sidebar-top:opacity-100 group-focus-within/sidebar-top:pointer-events-auto": !touch(),
          }}
        >
          <div class="relative">
            <Show when={props.renderSearch}>{(render) => render()()}</Show>
          </div>
          <Tooltip placement={placement()} value={props.expandAllLabel}>
            <IconButton
              icon="expand"
              variant="ghost"
              size="small"
              onClick={props.onExpandAll}
              aria-label={props.expandAllLabel}
            />
          </Tooltip>
          <Tooltip placement={placement()} value={props.collapseAllLabel}>
            <IconButton
              icon="collapse"
              variant="ghost"
              size="small"
              onClick={props.onCollapseAll}
              aria-label={props.collapseAllLabel}
            />
          </Tooltip>
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
              size="small"
              onClick={props.onOpenProject}
              aria-label={props.openProjectLabel}
            />
          </Tooltip>
        </div>
      </div>

      <div
        ref={(el) => props.setScrollRef(el)}
        data-component="sidebar-projects-scroll"
        class="flex-1 min-h-0 overflow-y-auto px-2 pb-2 no-scrollbar [overflow-anchor:none]"
      >
        <DragDropProvider
          onDragStart={props.handleDragStart}
          onDragEnd={props.handleDragEnd}
          onDragOver={props.handleDragOver}
          collisionDetector={closestCenter}
        >
          <DragDropSensors />
          <ConstrainDragXAxis />
          <SortableProvider ids={props.projects().map((p) => p.worktree)}>
            <div class="flex flex-col gap-1">
              <For each={props.projects()}>{(project) => props.renderProjectSection(project)}</For>
            </div>
          </SortableProvider>
          <DragOverlay>{props.renderProjectOverlay()}</DragOverlay>
        </DragDropProvider>
        <Show when={props.projects().length === 0}>{props.renderEmpty()}</Show>
        {props.renderGettingStarted()}
      </div>

      <div class="flex shrink-0 items-center gap-1 px-3 py-3">
        <TooltipKeybind placement={placement()} title={props.settingsLabel()} keybind={props.settingsKeybind() ?? ""}>
          <IconButton
            icon="settings-gear"
            variant="ghost"
            size="small"
            onClick={props.onOpenSettings}
            aria-label={props.settingsLabel()}
          />
        </TooltipKeybind>
      </div>
    </div>
  )
}
