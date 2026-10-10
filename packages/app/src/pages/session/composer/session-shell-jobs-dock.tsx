import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js"
import { useShellJobs } from "@opencode-ai/session-ui/context/shell-jobs"
import { ShellJobControls, useShellJobLive } from "@opencode-ai/session-ui/script-tool-card"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { ComposerPanelBar, useComposerTabs } from "./session-composer-tabs"

type Job = {
  id: string
  title: string
  metadata: Record<string, any>
}

/** 状态面板的“后台”标签：时间线折叠时也能实时看到仍在运行的后台命令输出。 */
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

  const tabs = useComposerTabs()
  // 多个任务时面板里再分小标签，默认选最新的
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

  // 有任务时注册到状态面板；新任务出现时把标签切过来（不展开，标签条预览最新输出）
  tabs.use(() => !!jobs && running().length > 0, {
    id: "shell",
    order: 2,
    label: () => language.t("session.composerTabs.shell"),
    meta: () => (running().length > 1 ? String(running().length) : undefined),
    tone: () => "busy",
    preview: () => last() || language.t("session.shellJobs.waiting"),
  })
  createEffect(
    on(
      () => running().length,
      (count, prev) => {
        if (count > (prev ?? 0)) tabs.notify("shell")
      },
    ),
  )

  let box: HTMLPreElement | undefined
  // 跟随到底部；用户往上翻时不打扰，切换任务后重新跟随
  let follow = true
  createEffect(() => {
    selected()
    follow = true
  })
  createEffect(() => {
    live.text()
    if (!tabs.expanded("shell") || !box || !follow) return
    box.scrollTop = box.scrollHeight
  })

  return (
    <Show when={jobs && tabs.active("shell") && selected()}>
      {(job) => (
        <div data-component="session-shell-jobs-dock">
          <ComposerPanelBar actions={<ShellJobControls metadata={job().metadata} title={job().title} />}>
            <Show
              when={running().length > 1}
              fallback={<span class="min-w-0 truncate text-text-strong">{job().title}</span>}
            >
              <div role="tablist" class="min-w-0 shrink flex items-center gap-0.5 overflow-x-auto no-scrollbar">
                <For each={running()}>
                  {(item) => (
                    <button
                      type="button"
                      role="tab"
                      data-slot="shell-jobs-dock-tab"
                      aria-selected={item.id === job().id}
                      class="shrink-0 max-w-40 truncate px-2 h-6 rounded-md text-12-medium"
                      classList={{
                        "bg-surface-raised-base text-text-strong": item.id === job().id,
                        "text-text-weak hover:text-text-base": item.id !== job().id,
                      }}
                      onClick={() => setPicked(item.id)}
                    >
                      {item.title}
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </ComposerPanelBar>
          <pre
            ref={box}
            data-slot="shell-jobs-dock-output"
            class="m-0 mt-0.5 px-2.5 py-2 rounded-lg bg-surface-raised-base max-h-40 overflow-y-auto overscroll-contain no-scrollbar text-12-regular text-text-weak font-mono whitespace-pre-wrap break-all"
            onScroll={(event) => {
              const el = event.currentTarget
              follow = el.scrollHeight - el.scrollTop - el.clientHeight < 8
            }}
          >
            {live.text() || language.t("session.shellJobs.waiting")}
          </pre>
        </div>
      )}
    </Show>
  )
}

function lastLine(text: string | undefined) {
  const all = (text ?? "").split("\n")
  for (let i = all.length - 1; i >= 0; i--) if (all[i].trim()) return all[i]
  return ""
}
