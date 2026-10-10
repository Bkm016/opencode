import {
  For,
  Show,
  createContext,
  createMemo,
  createEffect,
  createSignal,
  on,
  onCleanup,
  useContext,
  type Accessor,
  type JSX,
  type ParentProps,
} from "solid-js"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useLanguage } from "@/context/language"

/** 状态点：busy 呼吸（运行中），info 静态强调，idle 灰 */
export type ComposerTabTone = "busy" | "info" | "idle"

export type ComposerTab = {
  id: string
  /** 标签条里的排序，越小越靠左 */
  order: number
  label: Accessor<string>
  /** 标签上的短状态：计数、进度、状态词 */
  meta?: Accessor<string | undefined>
  tone?: Accessor<ComposerTabTone | undefined>
  /** 选中且收起时，标签条右侧显示的一行预览 */
  preview?: Accessor<string | undefined>
}

/**
 * 输入框上方的状态面板：目标、待办、后台任务、助手、排队消息共用一张卡片。
 * 顶部一排标签，同一时间只展开一个面板；面板内容由各个 dock 自己渲染，只在被选中时挂载。
 */
export function createComposerTabs() {
  const [tabs, setTabs] = createSignal<ComposerTab[]>([])
  const [picked, setPicked] = createSignal<string>()
  const [open, setOpen] = createSignal(false)
  // 用户手动点过标签后，新事件不再抢焦点；手动选中的标签消失后恢复自动
  const [manual, setManual] = createSignal(false)

  const list = createMemo(() => [...tabs()].sort((a, b) => a.order - b.order))
  const selected = createMemo(() => {
    const all = list()
    return all.find((tab) => tab.id === picked())?.id ?? all[0]?.id
  })

  const register = (tab: ComposerTab) => {
    setTabs((prev) => [...prev.filter((item) => item.id !== tab.id), tab])
    onCleanup(() => {
      setTabs((prev) => prev.filter((item) => item !== tab))
      if (picked() !== tab.id) return
      setPicked(undefined)
      setManual(false)
      setOpen(false)
    })
  }

  return {
    tabs: list,
    selected,
    open: () => open() && !!selected(),
    /** visible 为真时把标签挂到标签条上；只跟踪 visible，标签内容变化不会重新注册（否则会收起面板） */
    use(visible: Accessor<boolean>, tab: ComposerTab) {
      const shown = createMemo(visible)
      createEffect(
        on(shown, (value) => {
          if (value) register(tab)
        }),
      )
    },
    active: (id: string) => selected() === id,
    expanded: (id: string) => open() && selected() === id,
    /** 点击标签：切到该标签并展开；已展开的当前标签再点一次收起 */
    pick(id: string) {
      setManual(true)
      if (selected() === id) {
        setOpen((value) => !value)
        return
      }
      setPicked(id)
      setOpen(true)
    },
    toggle: () => setOpen((value) => !value),
    close: () => setOpen(false),
    /** 有新动静（新排队消息、新后台任务）时调用；用户没手动选过才切过去 */
    notify(id: string, input?: { open?: boolean }) {
      if (manual() && picked() !== id) return
      setPicked(id)
      if (input?.open) setOpen(true)
    },
  }
}

export type ComposerTabs = ReturnType<typeof createComposerTabs>

const Context = createContext<ComposerTabs>()

export function useComposerTabs() {
  const value = useContext(Context)
  if (!value) throw new Error("ComposerTabs context missing")
  return value
}

export function ComposerTabsProvider(props: ParentProps<{ value: ComposerTabs }>) {
  return <Context.Provider value={props.value}>{props.children}</Context.Provider>
}

/** 面板外壳：标签条 + 当前面板；没有任何标签时整张卡片不显示，但子组件照常挂载以便注册 */
export function SessionComposerTabs(props: { children: JSX.Element; attached?: boolean }) {
  const tabs = useComposerTabs()
  const language = useLanguage()
  const current = createMemo(() => tabs.tabs().find((tab) => tab.id === tabs.selected()))

  return (
    <div
      data-component="session-composer-tabs"
      data-open={tabs.open() ? "" : undefined}
      classList={{ hidden: tabs.tabs().length === 0, "mb-2": !!props.attached }}
    >
      <div class="h-10 pl-1.5 pr-1.5 flex items-center gap-2 min-w-0">
        <div role="tablist" class="min-w-0 shrink flex items-center gap-0.5 overflow-x-auto no-scrollbar">
          <For each={tabs.tabs()}>
            {(tab) => (
              <button
                type="button"
                role="tab"
                data-slot="composer-tab"
                data-tab={tab.id}
                aria-selected={tabs.selected() === tab.id}
                aria-expanded={tabs.expanded(tab.id)}
                class="shrink-0 h-7 px-2 flex items-center gap-1.5 rounded-md text-13-regular whitespace-nowrap transition-colors duration-100"
                classList={{
                  "bg-surface-raised-base-hover text-text-strong": tabs.selected() === tab.id,
                  "text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover": tabs.selected() !== tab.id,
                }}
                onClick={() => tabs.pick(tab.id)}
              >
                <Show when={tab.tone?.()}>
                  {(tone) => (
                    <span data-slot="composer-tab-dot" data-tone={tone()} class="shrink-0 size-1.5 rounded-full" />
                  )}
                </Show>
                <span>{tab.label()}</span>
                <Show when={tab.meta?.()}>{(meta) => <span class="text-text-weak tabular-nums">{meta()}</span>}</Show>
              </button>
            )}
          </For>
        </div>
        <span class="hidden sm:block min-w-0 flex-1 truncate text-13-regular text-text-weak">
          <Show when={!tabs.open()}>{current()?.preview?.()}</Show>
        </span>
        <IconButton
          icon="chevron-down"
          size="normal"
          variant="ghost"
          data-slot="dock-chevron"
          class="ml-auto shrink-0"
          style={{ transform: `rotate(${tabs.open() ? 0 : 180}deg)` }}
          onClick={tabs.toggle}
          aria-label={tabs.open() ? language.t("session.todo.collapse") : language.t("session.todo.expand")}
        />
      </div>
      <div data-slot="dock-reveal" data-open={tabs.open() ? "" : undefined} inert={!tabs.open()}>
        <div>
          <div data-slot="composer-tab-panel" role="tabpanel" class="px-1.5 pb-1.5">
            {props.children}
          </div>
        </div>
      </div>
    </div>
  )
}

/** 面板内的工具行：左侧标题/说明，右侧操作；所有面板统一高度与字号 */
export function ComposerPanelBar(props: { children?: JSX.Element; actions?: JSX.Element }) {
  return (
    <div class="h-8 pl-2 pr-0.5 flex items-center gap-2 min-w-0">
      <div class="min-w-0 flex-1 flex items-center gap-2 text-13-regular text-text-base">{props.children}</div>
      <Show when={props.actions}>
        <div class="shrink-0 flex items-center gap-1">{props.actions}</div>
      </Show>
    </div>
  )
}
