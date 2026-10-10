import { Icon } from "@opencode-ai/ui/icon"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { createFindMatcher, findPartText } from "@opencode-ai/core/util/session-find-text"
import type { OpencodeClient, Part } from "@opencode-ai/sdk/v2"
import {
  type Component,
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
} from "solid-js"
import { Portal } from "solid-js/web"
import { createMediaQuery } from "@solid-primitives/media"
import { useLanguage } from "@/context/language"
import {
  FIND_FILTERS,
  type FindFilter,
  type SessionFindHit,
  filterFindHits,
  findHitFilter,
  findHitKey,
  findPreviewLines,
} from "./session-find"

export type SessionFindOptions = { caseSensitive: boolean; word: boolean; regex: boolean }

export type SessionFindDialogProps = {
  open: boolean
  focusToken: number
  sessionID: string | undefined
  client: OpencodeClient
  query: string
  options: SessionFindOptions
  filter: FindFilter
  hideCompacted: boolean
  hits: readonly SessionFindHit[]
  total: number
  truncated: boolean
  error?: string
  pending: boolean
  selectedKey: string | undefined
  onQuery: (value: string) => void
  onOptions: (value: SessionFindOptions) => void
  onFilter: (value: FindFilter) => void
  onHideCompacted: (value: boolean) => void
  onSelect: (key: string) => void
  onJump: (hit: SessionFindHit) => void
  onClose: () => void
}

type Row =
  | { type: "turn"; turn: number; time: number; compacted: boolean }
  | { type: "hit"; hit: SessionFindHit; index: number }

// 列表一行放不下服务端给的整段前文，只留紧挨着命中的一小段，保证命中词总在可见范围内
function clipBefore(text: string, keep = 14) {
  const chars = Array.from(text.replace(/^…/, ""))
  if (chars.length <= keep) return text
  return `…${chars.slice(-keep).join("")}`
}

function formatTime(time: number) {
  const date = new Date(time)
  const pad = (value: number) => String(value).padStart(2, "0")
  const now = new Date()
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (date.toDateString() === now.toDateString()) return clock
  const day = `${date.getMonth() + 1}/${date.getDate()}`
  if (date.getFullYear() === now.getFullYear()) return `${day} ${clock}`
  return `${date.getFullYear()}/${day} ${clock}`
}

export const SessionFindDialog: Component<SessionFindDialogProps> = (props) => {
  const language = useLanguage()
  // 手机上全屏显示，去掉预览，点一下结果直接跳转
  const compact = createMediaQuery("(max-width: 767px)")
  let input: HTMLInputElement | undefined
  let list: HTMLDivElement | undefined
  let preview: HTMLDivElement | undefined

  createEffect(
    on(
      () => [props.open, props.focusToken] as const,
      ([open]) => {
        if (!open) return
        requestAnimationFrame(() => {
          input?.focus()
          input?.select()
        })
      },
    ),
  )

  const counts = createMemo(() => {
    const result: Record<FindFilter, number> = {
      all: 0,
      user: 0,
      assistant: 0,
      reasoning: 0,
      tool: 0,
      summary: 0,
      other: 0,
    }
    for (const hit of props.hits) {
      if (props.hideCompacted && hit.compacted) continue
      result.all++
      result[findHitFilter(hit)]++
    }
    return result
  })
  const compactedCount = createMemo(() => props.hits.filter((hit) => hit.compacted).length)

  const visible = createMemo(() => filterFindHits(props.hits, props.filter, props.hideCompacted))

  // 按轮次分组：结果从新到旧，同一轮的命中挂在一个轮次标题下
  const rows = createMemo(() => {
    const result: Row[] = []
    let turn: number | undefined
    visible().forEach((hit, index) => {
      if (hit.turn !== turn) {
        turn = hit.turn
        result.push({ type: "turn", turn: hit.turn, time: hit.time, compacted: hit.compacted })
      }
      result.push({ type: "hit", hit, index })
    })
    return result
  })

  const selectedIndex = createMemo(() => {
    const key = props.selectedKey
    const index = key ? visible().findIndex((hit) => findHitKey(hit) === key) : -1
    return index >= 0 ? index : 0
  })
  const selected = createMemo(() => visible()[selectedIndex()])

  const move = (delta: number) => {
    const hits = visible()
    if (hits.length === 0) return
    const next = Math.max(0, Math.min(hits.length - 1, selectedIndex() + delta))
    props.onSelect(findHitKey(hits[next]!))
  }

  createEffect(
    on(
      () => [selectedIndex(), rows()] as const,
      ([index]) => {
        requestAnimationFrame(() => {
          list?.querySelector<HTMLElement>(`[data-find-index="${index}"]`)?.scrollIntoView({ block: "nearest" })
        })
      },
    ),
  )

  // 预览：按需拉取命中所在的整条消息，缓存到弹窗关闭
  const [parts, setParts] = createSignal<Record<string, Part[] | "loading" | "error">>({})
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) setParts({})
      },
    ),
  )
  createEffect(
    on(
      () => [selected()?.messageID, props.sessionID] as const,
      ([messageID, sessionID]) => {
        if (!messageID || !sessionID || parts()[messageID]) return
        setParts((value) => ({ ...value, [messageID]: "loading" }))
        let cancelled = false
        props.client.session
          .message({ sessionID, messageID })
          .then((response) => {
            if (cancelled) return
            setParts((value) => ({ ...value, [messageID]: response.data?.parts ?? "error" }))
          })
          .catch(() => {
            if (!cancelled) setParts((value) => ({ ...value, [messageID]: "error" }))
          })
        onCleanup(() => {
          cancelled = true
          setParts((value) => {
            if (value[messageID] !== "loading") return value
            const next = { ...value }
            delete next[messageID]
            return next
          })
        })
      },
    ),
  )

  const previewState = createMemo(() => {
    const hit = selected()
    if (!hit) return { type: "empty" as const }
    const loaded = parts()[hit.messageID]
    if (!loaded || loaded === "loading") return { type: "loading" as const }
    if (loaded === "error") return { type: "error" as const }
    const part = loaded.find((item) => item.id === hit.partID)
    const source = part ? findPartText(part) : undefined
    if (!source) return { type: "error" as const }
    const matcher = createFindMatcher(props.query, props.options)
    const ranges = matcher && "match" in matcher ? matcher.match(source.text) : []
    // 服务端的位置优先；内容在两次请求之间变了就退回到同序号的本地命中
    const active = ranges.find((range) => range.start === hit.start && range.end === hit.end) ??
      ranges[hit.ordinal] ?? { start: hit.start, end: hit.end }
    return { type: "ready" as const, hit, ...findPreviewLines(source.text, ranges, active) }
  })

  createEffect(
    on(previewState, (state) => {
      if (state.type !== "ready") return
      requestAnimationFrame(() => {
        const line = preview?.querySelector<HTMLElement>("[data-active-line]")
        if (!line || !preview) return
        preview.scrollTop = line.offsetTop - preview.clientHeight / 2 + line.offsetHeight / 2
        const mark = line.querySelector<HTMLElement>("[data-mark='active']")
        if (mark) preview.scrollLeft = Math.max(0, mark.offsetLeft - preview.clientWidth / 3)
      })
    }),
  )

  const kindLabel = (hit: SessionFindHit) => {
    if (hit.kind === "tool") return hit.tool ?? "tool"
    if (hit.kind === "text")
      return language.t(hit.role === "user" ? "session.find.kind.user" : "session.find.kind.assistant")
    return language.t(`session.find.kind.${hit.kind}`)
  }

  const toggle = (key: keyof SessionFindOptions) => props.onOptions({ ...props.options, [key]: !props.options[key] })

  const onKeyDown = (event: KeyboardEvent) => {
    const stop = () => {
      event.preventDefault()
      event.stopPropagation()
    }
    if (event.key === "Escape") {
      stop()
      props.onClose()
      return
    }
    if (event.key === "ArrowDown") return (stop(), move(1))
    if (event.key === "ArrowUp") return (stop(), move(-1))
    if (event.key === "PageDown") return (stop(), move(10))
    if (event.key === "PageUp") return (stop(), move(-10))
    if (event.key === "Enter") {
      stop()
      const hit = selected()
      if (hit) props.onJump(hit)
      return
    }
    // 与 IDEA 一致：Alt+C 大小写，Alt+W 全词，Alt+X 正则
    if (event.altKey && !event.ctrlKey && !event.metaKey) {
      const key = { KeyC: "caseSensitive", KeyW: "word", KeyX: "regex" }[event.code] as
        | keyof SessionFindOptions
        | undefined
      if (key) {
        stop()
        toggle(key)
      }
    }
  }

  const OptionButton = (input: { key: keyof SessionFindOptions; label: string; title: string }) => (
    <button
      type="button"
      data-action={`session-find-${input.key}`}
      aria-pressed={props.options[input.key]}
      title={input.title}
      aria-label={input.title}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => toggle(input.key)}
      class="shrink-0 h-6 min-w-6 px-1 rounded-md font-mono text-12-medium transition-colors"
      classList={{
        "text-text-weaker hover:text-text-base": !props.options[input.key],
        "bg-surface-raised-base-active text-text-strong": props.options[input.key],
      }}
    >
      {input.label}
    </button>
  )

  const Mark = (input: { text: string; active?: boolean }) => (
    <mark
      data-mark={input.active ? "active" : "hit"}
      class="rounded-[3px] text-text-strong"
      classList={{
        "bg-[var(--session-find-hit)]": !input.active,
        "bg-[var(--session-find-active)] !text-black": input.active,
      }}
    >
      {input.text}
    </mark>
  )

  return (
    <Show when={props.open}>
      <Portal>
        <div
          data-component="session-find-dialog"
          class="fixed inset-0 z-50 flex items-center justify-center md:p-6 bg-[hsl(from_var(--background-base)_h_s_l/0.2)]"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) props.onClose()
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={language.t("session.find.title")}
            onKeyDown={onKeyDown}
            class="flex flex-col w-full h-[100dvh] bg-surface-raised-stronger-non-alpha overflow-hidden md:max-w-[1040px] md:h-[min(720px,calc(100dvh-48px))] md:rounded-[var(--radius-xl)] md:shadow-[var(--shadow-lg-border-base)]"
          >
            {/* 标题 */}
            <div class="flex items-center gap-3 pl-5 pr-3 pt-4 pb-3 shrink-0">
              <span class="shrink-0 whitespace-nowrap text-16-medium text-text-strong">
                {language.t("session.find.title")}
              </span>
              <span
                class="hidden md:inline min-w-0 truncate text-14-regular text-text-weak tabular-nums"
                data-slot="session-find-counter"
              >
                <Switch>
                  <Match when={!props.query.trim()}>{""}</Match>
                  <Match when={props.error}>{""}</Match>
                  <Match when={props.pending && props.hits.length === 0}>{language.t("session.find.searching")}</Match>
                  <Match when={props.hits.length === 0}>{language.t("session.find.none")}</Match>
                  <Match when={compactedCount() > 0}>
                    {language.t("session.find.statsCompacted", {
                      total: String(props.total),
                      compacted: String(compactedCount()),
                    })}
                  </Match>
                  <Match when={true}>{language.t("session.find.stats", { total: String(props.total) })}</Match>
                </Switch>
              </span>
              <Show when={props.pending && props.hits.length > 0}>
                <Spinner class="size-3.5 text-icon-weak-base" />
              </Show>
              <div class="flex-1" />
              <IconButton
                icon="close"
                variant="ghost"
                onClick={() => props.onClose()}
                aria-label={language.t("session.find.close")}
              />
            </div>

            {/* 搜索框：与列表组件的搜索框同款 */}
            <div class="px-4 shrink-0">
              <div class="flex items-center gap-2 h-10 rounded-[var(--radius-md)] bg-surface-base pl-3 pr-1.5">
                <Icon name="magnifying-glass" class="text-icon-base shrink-0" />
                <input
                  ref={(el) => {
                    input = el
                  }}
                  type="text"
                  value={props.query}
                  onInput={(event) => props.onQuery(event.currentTarget.value)}
                  placeholder={language.t("session.find.placeholder")}
                  spellcheck={false}
                  autocomplete="off"
                  autocapitalize="off"
                  class="flex-1 min-w-0 h-full bg-transparent border-0 outline-none text-14-regular text-text-strong placeholder:text-text-weak"
                  classList={{ "font-mono": props.options.regex }}
                  aria-label={language.t("session.find.placeholder")}
                />
                <OptionButton
                  key="caseSensitive"
                  label="Aa"
                  title={`${language.t("session.find.caseSensitive")} (Alt+C)`}
                />
                <OptionButton key="word" label="ab" title={`${language.t("session.find.word")} (Alt+W)`} />
                <OptionButton key="regex" label=".*" title={`${language.t("session.find.regex")} (Alt+X)`} />
              </div>
              <Show when={props.error}>
                <div class="px-1 pt-2 text-13-regular text-text-critical truncate" data-slot="session-find-error">
                  {props.error}
                </div>
              </Show>
            </div>

            {/* 分类：安静的文字页签 */}
            <div class="flex flex-wrap items-center gap-1 px-4 pt-3 pb-1 shrink-0">
              <For each={FIND_FILTERS}>
                {(filter) => (
                  <Show when={filter === "all" || counts()[filter] > 0 || props.filter === filter}>
                    <button
                      type="button"
                      data-find-filter={filter}
                      aria-pressed={props.filter === filter}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => props.onFilter(filter)}
                      class="shrink-0 flex items-center gap-1 h-7 rounded-[var(--radius-md)] px-2.5 text-13-medium transition-colors"
                      classList={{
                        "text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover":
                          props.filter !== filter,
                        "bg-surface-raised-base-active text-text-strong": props.filter === filter,
                      }}
                    >
                      {language.t(`session.find.filter.${filter}`)}
                      <span class="tabular-nums text-12-regular text-text-weaker">{counts()[filter]}</span>
                    </button>
                  </Show>
                )}
              </For>
              <div class="flex-1" />
              <Show when={compactedCount() > 0}>
                <button
                  type="button"
                  data-action="session-find-hide-compacted"
                  aria-pressed={props.hideCompacted}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => props.onHideCompacted(!props.hideCompacted)}
                  class="shrink-0 h-7 rounded-[var(--radius-md)] px-2.5 text-13-regular transition-colors"
                  classList={{
                    "text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover": !props.hideCompacted,
                    "bg-surface-raised-base-active text-text-strong": props.hideCompacted,
                  }}
                >
                  {language.t("session.find.hideCompacted")}
                </button>
              </Show>
            </div>

            <div class="flex-1 min-h-0 flex flex-col md:flex-row gap-2 px-2 pb-2">
              {/* 结果列表 */}
              <div
                ref={(el) => {
                  list = el
                }}
                role="listbox"
                data-slot="session-find-results"
                class="flex-1 md:flex-none md:w-[46%] min-h-0 overflow-y-auto overscroll-contain px-2 pb-2 [scrollbar-width:thin]"
              >
                <Switch>
                  <Match when={!props.query.trim()}>
                    <div class="h-full flex items-center justify-center px-6 text-14-regular text-text-weak text-center">
                      {language.t("session.find.typeToSearch")}
                    </div>
                  </Match>
                  <Match when={!props.pending && !props.error && visible().length === 0}>
                    <div class="h-full flex items-center justify-center text-14-regular text-text-weak">
                      {language.t("session.find.empty")}
                    </div>
                  </Match>
                  <Match when={true}>
                    <For each={rows()}>
                      {(row) => (
                        <Switch>
                          <Match when={row.type === "turn" && row}>
                            {(item) => (
                              <div class="sticky top-0 z-10 flex items-center gap-2 px-2 pt-3 pb-1 bg-surface-raised-stronger-non-alpha text-12-medium text-text-weak">
                                <span>{language.t("session.find.turn", { turn: String(item().turn) })}</span>
                                <span class="tabular-nums font-normal text-text-weaker">{formatTime(item().time)}</span>
                                <Show when={item().compacted}>
                                  <span
                                    class="font-normal text-text-weaker"
                                    title={language.t("session.find.compactedHint")}
                                  >
                                    · {language.t("session.find.compacted")}
                                  </span>
                                </Show>
                              </div>
                            )}
                          </Match>
                          <Match when={row.type === "hit" && row}>
                            {(item) => (
                              <button
                                type="button"
                                role="option"
                                data-find-index={item().index}
                                aria-selected={item().index === selectedIndex()}
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() =>
                                  compact() ? props.onJump(item().hit) : props.onSelect(findHitKey(item().hit))
                                }
                                onDblClick={() => props.onJump(item().hit)}
                                class="flex w-full flex-col gap-0.5 rounded-[var(--radius-md)] px-2 py-1.5 text-left [content-visibility:auto] [contain-intrinsic-size:auto_48px]"
                                classList={{
                                  "bg-surface-raised-base-hover": item().index === selectedIndex(),
                                  "hover:bg-surface-raised-base-hover": item().index !== selectedIndex(),
                                  "opacity-60": item().hit.compacted && item().index !== selectedIndex(),
                                }}
                              >
                                <span class="text-12-regular text-text-weaker truncate max-w-full">
                                  {kindLabel(item().hit)}
                                </span>
                                <span
                                  class="w-full text-14-regular text-text-base"
                                  classList={{ truncate: !compact(), "line-clamp-2 break-words": compact() }}
                                >
                                  {clipBefore(item().hit.before, compact() ? 40 : 14)}
                                  <Mark text={item().hit.match} />
                                  {item().hit.after}
                                </span>
                              </button>
                            )}
                          </Match>
                        </Switch>
                      )}
                    </For>
                    <Show when={props.truncated}>
                      <div class="px-2 py-2 text-12-regular text-text-weaker">
                        {language.t("session.find.truncated", {
                          shown: String(props.hits.length),
                          total: String(props.total),
                        })}
                      </div>
                    </Show>
                  </Match>
                </Switch>
              </div>

              {/* 预览：一张柔和的卡片，按消息原样排版 */}
              <Show when={!compact()}>
                <div
                  class="flex-1 min-h-0 flex flex-col rounded-[var(--radius-lg)] bg-surface-base overflow-hidden"
                  data-slot="session-find-preview"
                >
                  <Show when={selected()}>
                    {(hit) => (
                      <div class="flex items-center gap-1.5 pl-4 pr-2 pt-2 pb-1 shrink-0 text-12-regular text-text-weak">
                        <span class="text-12-medium text-text-base truncate">{kindLabel(hit())}</span>
                        <span class="text-text-weaker">·</span>
                        <span class="shrink-0">{language.t("session.find.turn", { turn: String(hit().turn) })}</span>
                        <span class="text-text-weaker">·</span>
                        <span class="shrink-0 tabular-nums">{formatTime(hit().time)}</span>
                        <Show when={hit().compacted}>
                          <span class="text-text-weaker">·</span>
                          <span class="truncate text-text-weaker">{language.t("session.find.compactedHint")}</span>
                        </Show>
                        <div class="flex-1" />
                        <Button
                          variant="ghost"
                          size="small"
                          data-action="session-find-jump"
                          onClick={() => props.onJump(hit())}
                          class="shrink-0"
                        >
                          {language.t("session.find.jump")}
                        </Button>
                      </div>
                    )}
                  </Show>
                  <div
                    ref={(el) => {
                      preview = el
                    }}
                    class="flex-1 min-h-0 overflow-auto px-2 pb-3 [scrollbar-width:thin]"
                  >
                    <Switch>
                      <Match when={previewState().type === "loading"}>
                        <div class="h-full flex items-center justify-center text-text-weak">
                          <Spinner class="size-4" />
                        </div>
                      </Match>
                      <Match when={previewState().type === "error"}>
                        <div class="h-full flex items-center justify-center text-text-weak text-14-regular">
                          {language.t("session.find.previewError")}
                        </div>
                      </Match>
                      <Match when={previewState().type === "empty"}>{null}</Match>
                      <Match when={previewState().type === "ready" && previewState()}>
                        {(state) => {
                          const ready = () => state() as Extract<ReturnType<typeof previewState>, { type: "ready" }>
                          // 工具输出按代码排版，其余按对话正文排版
                          const code = () => ready().hit.kind === "tool"
                          return (
                            <div
                              classList={{
                                "font-mono text-12-regular leading-5 min-w-max": code(),
                                "text-14-regular leading-6": !code(),
                              }}
                            >
                              <Show when={ready().clippedStart}>
                                <div class="px-2 text-text-weaker">…</div>
                              </Show>
                              <For each={ready().lines}>
                                {(line) => (
                                  <div
                                    data-active-line={line.no === ready().activeLine ? "" : undefined}
                                    class="px-2 rounded-[var(--radius-sm)] text-text-base"
                                    classList={{
                                      "whitespace-pre": code(),
                                      "whitespace-pre-wrap break-words": !code(),
                                      "bg-surface-raised-base-hover": line.no === ready().activeLine,
                                    }}
                                  >
                                    <For each={line.segments}>
                                      {(segment) =>
                                        segment.mark ? (
                                          <Mark text={segment.text} active={segment.mark === "active"} />
                                        ) : (
                                          segment.text
                                        )
                                      }
                                    </For>
                                    {line.segments.length === 0 ? " " : ""}
                                  </div>
                                )}
                              </For>
                              <Show when={ready().clippedEnd}>
                                <div class="px-2 text-text-weaker">…</div>
                              </Show>
                            </div>
                          )
                        }}
                      </Match>
                    </Switch>
                  </div>
                </div>
              </Show>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  )
}
