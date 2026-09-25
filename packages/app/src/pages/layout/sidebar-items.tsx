import type { Session } from "@opencode-ai/sdk/v2/client"
import { ContextMenu } from "@opencode-ai/ui/context-menu"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { A, useNavigate, useParams } from "@solidjs/router"
import { type Accessor, createMemo, For, type JSX, Match, Show, Switch } from "solid-js"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePermission } from "@/context/permission"
import { messageAgentColor } from "@/utils/agent"
import { isSessionPinned, toggleSessionPin } from "@/utils/session-pin"
import { sessionTitle } from "@/utils/session-title"
import { sessionPermissionRequest } from "../session/composer/session-request-tree"
import { sidebarChildSessions } from "./helpers"

export type SessionItemProps = {
  session: Session
  list: Session[]
  navList?: Accessor<Session[]>
  slug: string
  mobile?: boolean
  dense?: boolean
  showTooltip?: boolean
  showChild?: boolean
  level?: number
  sidebarExpanded: Accessor<boolean>
  prefetchSession: (session: Session, priority?: "high" | "low") => void
  archiveSession: (session: Session) => Promise<void>
}

const SessionRow = (props: {
  session: Session
  slug: string
  mobile?: boolean
  dense?: boolean
  pinned: Accessor<boolean>
  tint: Accessor<string | undefined>
  isWorking: Accessor<boolean>
  hasPermissions: Accessor<boolean>
  warmPress: () => void
  warmFocus: () => void
}): JSX.Element => {
  const navigate = useNavigate()
  const title = () => sessionTitle(props.session.title)

  return (
    <A
      href={`/${props.slug}/session/${props.session.id}`}
      class={`flex items-center gap-2 min-w-0 w-full text-left focus:outline-none ${props.dense ? "py-0.5" : "py-1"}`}
      onPointerDown={props.warmPress}
      onFocus={props.warmFocus}
      onClick={(event) => {
        // Force route change even if a parent layer ate the default <A> navigation.
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return
        }
        event.preventDefault()
        navigate(`/${props.slug}/session/${props.session.id}`)
      }}
    >
      {/* 前置位常驻以保持标题对齐：显示会话最近使用的模型图标；运行时在图标外圈叠加旋转环，待授权状态优先显示提示点 */}
      <div
        class="relative shrink-0 size-6 flex items-center justify-center"
        style={{ color: props.tint() ?? "var(--icon-interactive-base)" }}
      >
        <Show
          when={props.session.model}
          fallback={
            <Switch>
              <Match when={props.isWorking()}>
                <Spinner class="size-[15px]" />
              </Match>
              <Match when={props.hasPermissions()}>
                <div class="size-1.5 rounded-full bg-surface-warning-strong" />
              </Match>
            </Switch>
          }
        >
          {(model) => (
            <>
              <Show when={props.isWorking()}>
                {/* 旋转弧环绕模型图标，替代原先的独立转圈 */}
                <div class="absolute inset-0 animate-spin rounded-full border border-transparent border-t-current [animation-duration:1.2s]" />
              </Show>
              <ProviderIcon
                id={model().providerID}
                model={model().id}
                classList={{ "opacity-60": props.hasPermissions() }}
                class="size-3.5 text-icon-base opacity-70 group-hover/session:opacity-100 group-has-[.active]/session:opacity-100 transition-opacity"
              />
              <Show when={props.hasPermissions()}>
                <div class="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-surface-warning-strong" />
              </Show>
            </>
          )}
        </Show>
      </div>
      <span class="min-w-0 flex-1 truncate text-14-regular text-text-strong opacity-70 group-hover/session:opacity-100 group-has-[.active]/session:opacity-100 transition-opacity">{title()}</span>
    </A>
  )
}

export const SessionItem = (props: SessionItemProps): JSX.Element => {
  const params = useParams()
  const layout = useLayout()
  const language = useLanguage()
  const permission = usePermission()
  const serverSync = useServerSync()
  const [sessionStore] = serverSync().child(props.session.directory)
  const hasPermissions = createMemo(() => {
    return !!sessionPermissionRequest(
      sessionStore.session,
      serverSync().session.data.permission,
      props.session.id,
      (item) => {
        return !permission.autoResponds(item, props.session.directory)
      },
    )
  })
  const isWorking = createMemo(() => {
    if (hasPermissions()) return false
    return serverSync().session.data.session_working(props.session.id)
  })

  const tint = createMemo(() =>
    messageAgentColor(serverSync().session.data.message[props.session.id], sessionStore.agent),
  )
  const tooltip = createMemo(() => props.showTooltip ?? (props.mobile || !props.sidebarExpanded()))
  const childSessions = createMemo(() => {
    if (!props.showChild) return []
    return sidebarChildSessions(sessionStore.session, props.session.id, params.id, (id) =>
      serverSync().session.data.session_working(id),
    )
  })

  const warm = (span: number, priority: "high" | "low") => {
    const nav = props.navList?.()
    const list = nav?.some((item) => item.id === props.session.id && item.directory === props.session.directory)
      ? nav
      : props.list

    props.prefetchSession(props.session, priority)

    const idx = list.findIndex((item) => item.id === props.session.id && item.directory === props.session.directory)
    if (idx === -1) return

    for (let step = 1; step <= span; step++) {
      const next = list[idx + step]
      if (next) props.prefetchSession(next, step === 1 ? "high" : priority)

      const prev = list[idx - step]
      if (prev) props.prefetchSession(prev, step === 1 ? "high" : priority)
    }
  }

  const pinned = createMemo(() => !props.level && isSessionPinned(props.session.directory, props.session.id))
  const item = (
    <SessionRow
      session={props.session}
      slug={props.slug}
      mobile={props.mobile}
      dense={props.dense}
      pinned={pinned}
      tint={tint}
      isWorking={isWorking}
      hasPermissions={hasPermissions}
      warmPress={() => warm(2, "high")}
      warmFocus={() => warm(2, "high")}
    />
  )

  const row = (
    <div
      data-session-id={props.session.id}
      data-pinned={pinned() ? "true" : undefined}
      class="group/session relative w-full min-w-0 rounded-md cursor-default pr-3 transition-colors hover:bg-surface-raised-base-hover [&:has(:focus-visible)]:bg-surface-raised-base-hover has-[[data-expanded]]:bg-surface-raised-base-hover has-[.active]:bg-surface-base-active"
      style={{ "padding-left": `${8 + (props.level ?? 0) * 16}px` }}
    >
      <div class="flex min-w-0 items-center gap-1">
        <div class="min-w-0 flex-1">
          <Show
            when={!tooltip()}
            fallback={
              <Tooltip
                placement={props.mobile ? "bottom" : "right"}
                value={sessionTitle(props.session.title)}
                gutter={10}
                class="min-w-0 w-full"
              >
                {item}
              </Tooltip>
            }
          >
            {item}
          </Show>
        </div>

        <Show when={!props.level}>
          <div
            class="shrink-0 overflow-hidden transition-[width,opacity]"
            classList={{
              "w-6 opacity-100 pointer-events-auto": !!props.mobile,
              "w-0 opacity-0 pointer-events-none": !props.mobile,
              "group-hover/session:w-6 group-hover/session:opacity-100 group-hover/session:pointer-events-auto": true,
              "group-focus-within/session:w-6 group-focus-within/session:opacity-100 group-focus-within/session:pointer-events-auto": true,
            }}
          >
            <Tooltip value={language.t("common.archive")} placement="top">
              <IconButton
                icon="archive"
                variant="ghost"
                class="size-6 rounded-md"
                aria-label={language.t("common.archive")}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  void props.archiveSession(props.session)
                }}
              />
            </Tooltip>
          </div>
        </Show>
      </div>
    </div>
  )

  return (
    <>
      <Show when={!props.level} fallback={row}>
        <ContextMenu>
          <ContextMenu.Trigger as="div" class="w-full min-w-0">
            {row}
          </ContextMenu.Trigger>
          <ContextMenu.Portal>
            <ContextMenu.Content>
              <ContextMenu.Item
                onSelect={() => toggleSessionPin(props.session.directory, props.session.id)}
              >
                <ContextMenu.ItemLabel>
                  {pinned() ? language.t("common.unpin") : language.t("common.pin")}
                </ContextMenu.ItemLabel>
              </ContextMenu.Item>
              <ContextMenu.Item onSelect={() => void props.archiveSession(props.session)}>
                <ContextMenu.ItemLabel>{language.t("common.archive")}</ContextMenu.ItemLabel>
              </ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Portal>
        </ContextMenu>
      </Show>
      <For each={childSessions()}>
        {(child) => (
          <div class="w-full">
            <SessionItem {...props} session={child} level={(props.level ?? 0) + 1} />
          </div>
        )}
      </For>
    </>
  )
}

export const SessionSkeleton = (props: { count?: number }): JSX.Element => {
  const items = Array.from({ length: props.count ?? 4 }, (_, index) => index)
  return (
    <div class="flex flex-col gap-1">
      <For each={items}>
        {() => <div class="h-8 w-full rounded-md bg-surface-raised-base opacity-60 animate-pulse" />}
      </For>
    </div>
  )
}
