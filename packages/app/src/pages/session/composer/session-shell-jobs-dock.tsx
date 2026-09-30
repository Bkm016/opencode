import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import { DockTray } from "@opencode-ai/ui/dock-surface"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useShellJobs } from "@opencode-ai/session-ui/context/shell-jobs"
import { ShellJobControls, useShellJobLive } from "@opencode-ai/session-ui/script-tool-card"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"

type Job = {
  id: string
  title: string
  metadata: Record<string, any>
}

/** 输入框上方的后台任务栏：时间线折叠时也能实时看到仍在运行的后台命令输出。 */
export function SessionShellJobsDock(props: { sessionID: string }) {
  const sync = useSync()
  const jobs = useShellJobs()
  const language = useLanguage()

  const all = createMemo(() => {
    const data = sync().data
    const result: Job[] = []
    for (const message of data.message[props.sessionID] ?? []) {
      for (const part of data.part[message.id] ?? []) {
        if (part.type !== "tool" || part.tool !== "bash") continue
        const state = part.state as { input?: Record<string, any>; metadata?: Record<string, any> }
        const metadata = state.metadata
        if (metadata?.background !== true || typeof metadata.jobId !== "string") continue
        const command = typeof state.input?.command === "string" ? state.input.command : ""
        const description = typeof state.input?.description === "string" ? state.input.description : ""
        result.push({ id: metadata.jobId, title: description || command.split("\n")[0] || metadata.jobId, metadata })
      }
    }
    return result
  })

  const running = createMemo(
    () => all().filter((job) => jobs?.running(job.id) ?? job.metadata.status === "running"),
    [],
    { equals: (a, b) => a.length === b.length && a.every((job, i) => job.id === b[i]?.id) },
  )

  // 标签页：每个任务一个标签，默认选最新的；收起时只占一行（显示所选任务的最新一行输出），展开看所选任务的完整输出
  const [expanded, setExpanded] = createSignal(false)
  const [picked, setPicked] = createSignal<string>()
  const selected = createMemo(() => {
    const list = running()
    return list.find((job) => job.id === picked()) ?? list.at(-1)
  })
  const live = useShellJobLive(
    () => selected()?.metadata,
    () => true,
  )
  const last = createMemo(() => lastLine(live.text()))
  const toggleExpanded = () => setExpanded((value) => !value)

  let box: HTMLPreElement | undefined
  // 跟随到底部；用户往上翻时不打扰，切换标签后重新跟随
  let follow = true
  createEffect(() => {
    selected()
    follow = true
  })
  createEffect(() => {
    live.text()
    if (!expanded() || !box || !follow) return
    box.scrollTop = box.scrollHeight
  })

  return (
    <Show when={jobs && selected()}>
      {(job) => (
        <DockTray data-component="session-shell-jobs-dock" class="py-1">
          <div
            class="pl-3 pr-2 py-1 flex items-center gap-2 cursor-pointer"
            role="button"
            tabIndex={0}
            aria-expanded={expanded()}
            onClick={toggleExpanded}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return
              if (event.key !== "Enter" && event.key !== " ") return
              event.preventDefault()
              toggleExpanded()
            }}
          >
            <span data-slot="shell-jobs-dock-dot" class="shrink-0 size-1.5 rounded-full bg-icon-success-base" />
            <Show
              when={running().length > 1}
              fallback={
                <>
                  <span class="shrink-0 text-13-medium text-text-strong">{language.t("session.shellJobs.title")}</span>
                  <span class="min-w-0 shrink truncate text-13-regular text-text-base">{job().title}</span>
                </>
              }
            >
              <div role="tablist" class="min-w-0 shrink flex items-center gap-0.5 overflow-x-auto no-scrollbar">
                <For each={running()}>
                  {(item) => (
                    <button
                      type="button"
                      role="tab"
                      data-slot="shell-jobs-dock-tab"
                      aria-selected={item.id === job().id}
                      class="shrink-0 max-w-40 truncate px-2 py-0.5 rounded-md text-12-medium"
                      classList={{
                        "bg-surface-raised-base text-text-strong": item.id === job().id,
                        "text-text-weak hover:text-text-base": item.id !== job().id,
                      }}
                      onClick={(event) => {
                        event.stopPropagation()
                        setPicked(item.id)
                      }}
                    >
                      {item.title}
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <span class="min-w-16 flex-1 truncate text-12-regular text-text-weak font-mono">
              <Show when={!expanded()}>{last() || language.t("session.shellJobs.waiting")}</Show>
            </span>
            <div class="flex items-center gap-1 shrink-0">
              <ShellJobControls metadata={job().metadata} title={job().title} />
              <IconButton
                icon="chevron-down"
                size="normal"
                variant="ghost"
                style={{ transform: `rotate(${expanded() ? 0 : 180}deg)` }}
                onClick={(event) => {
                  event.stopPropagation()
                  toggleExpanded()
                }}
                aria-label={expanded() ? language.t("session.todo.collapse") : language.t("session.todo.expand")}
              />
            </div>
          </div>
          <Show when={expanded()}>
            <pre
              ref={box}
              role="tabpanel"
              data-slot="shell-jobs-dock-output"
              class="pl-6.5 pr-3 pb-2 max-h-32 overflow-y-auto no-scrollbar text-12-regular text-text-weak font-mono whitespace-pre-wrap break-all"
              onScroll={(event) => {
                const el = event.currentTarget
                follow = el.scrollHeight - el.scrollTop - el.clientHeight < 8
              }}
            >
              {live.text() || language.t("session.shellJobs.waiting")}
            </pre>
          </Show>
        </DockTray>
      )}
    </Show>
  )
}

function lastLine(text: string | undefined) {
  const all = (text ?? "").split("\n")
  for (let i = all.length - 1; i >= 0; i--) if (all[i].trim()) return all[i]
  return ""
}
