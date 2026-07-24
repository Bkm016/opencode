import { For, Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DockTray } from "@opencode-ai/ui/dock-surface"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TextField } from "@opencode-ai/ui/text-field"
import type { SessionGoal, SessionGoalLesson } from "@opencode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { formatServerError } from "@/utils/server-errors"
import { showToast } from "@/utils/toast"
import { getSessionContext } from "@/components/session/session-context-metrics"

type GoalData = {
  goal: SessionGoal
  lessons: SessionGoalLesson[]
}

export function SessionGoalDock(props: { sessionID: string }) {
  const language = useLanguage()
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const [data, setData] = createSignal<GoalData | null>()
  const [error, setError] = createSignal<unknown>()
  const [collapsed, setCollapsed] = createSignal(true)
  let request = 0

  const load = () => {
    const current = ++request
    return sdk()
      .client.goal.get({ sessionID: props.sessionID })
      .then((response) => {
        const goal = response.data
        if (!goal) return null
        return sdk()
          .client.goal.lessons({ sessionID: props.sessionID })
          .then((lessons) => ({ goal, lessons: lessons.data ?? [] }))
      })
      .then((next) => {
        if (current !== request) return
        setData(next)
        setError(undefined)
      })
      .catch((cause) => {
        if (current !== request) return
        setError(cause)
      })
  }

  createEffect(() => {
    props.sessionID
    void load()
  })

  // SSE 只负责触发刷新，初始状态与重连后的状态始终从持久 API 读取。
  createEffect(() => {
    const event = sdk().event
    const refresh = (sessionID: string) => {
      if (sessionID === props.sessionID) void load()
    }
    const offUpdated = event.on("session.goal.updated", (event) => refresh(event.properties.sessionID))
    const offCleared = event.on("session.goal.cleared", (event) => refresh(event.properties.sessionID))
    const offLessonUpdated = event.on("session.goal.lesson.updated", (event) => refresh(event.properties.sessionID))
    const offLessonDeleted = event.on("session.goal.lesson.deleted", (event) => refresh(event.properties.sessionID))
    onCleanup(() => {
      offUpdated()
      offCleared()
      offLessonUpdated()
      offLessonDeleted()
    })
  })

  const goal = createMemo(() => data()?.goal)
  const lessons = createMemo(() => data()?.lessons ?? [])
  const activeLessons = createMemo(() => lessons().filter((lesson) => !lesson.disabledAt))
  const working = createMemo(() => sync().data.session_working(props.sessionID))
  const contextTokens = createMemo(
    () => getSessionContext(sync().data.message[props.sessionID] ?? [])?.total.toLocaleString(language.intl()) ?? "0",
  )

  const statusLabel = (status: SessionGoal["status"]) => {
    if (status === "active") return language.t("goal.dock.status.active")
    if (status === "paused") return language.t("goal.dock.status.paused")
    if (status === "complete") return language.t("goal.dock.status.complete")
    if (status === "blocked") return language.t("goal.dock.status.blocked")
    if (status === "budget_limited") return language.t("goal.dock.status.budgetLimited")
    return language.t("goal.dock.status.usageLimited")
  }

  const tokens = createMemo(() => {
    const current = goal()
    if (!current) return ""
    const used = current.tokensUsed.toLocaleString()
    if (current.tokenBudget === undefined) return language.t("goal.dock.tokensUnlimited", { used })
    return language.t("goal.dock.tokensUsed", {
      used,
      budget: current.tokenBudget.toLocaleString(),
    })
  })

  const elapsed = createMemo(() => {
    const seconds = goal()?.timeUsedSeconds ?? 0
    if (seconds < 60) return language.t("goal.dock.seconds", { value: Math.round(seconds) })
    return language.t("goal.dock.minutes", { value: Math.round(seconds / 60) })
  })

  const actionError = (title: string, cause: unknown) => {
    showToast({
      title,
      description: formatServerError(cause, language.t, language.t("common.requestFailed")),
      variant: "error",
    })
  }

  const runAction = (input: { request: Promise<unknown>; success: string; failure: string }) => {
    void input.request
      .then(() => {
        showToast({ title: input.success, variant: "success" })
        return load()
      })
      .catch((cause) => actionError(input.failure, cause))
  }

  const pause = () => {
    runAction({
      request: sdk().client.goal.pause({ sessionID: props.sessionID }),
      success: language.t("goal.toast.pauseSuccess.title"),
      failure: language.t("goal.toast.pauseFailed.title"),
    })
  }

  const resume = () => {
    runAction({
      request: sdk().client.goal.resume({ sessionID: props.sessionID }),
      success: language.t("goal.toast.resumeSuccess.title"),
      failure: language.t("goal.toast.resumeFailed.title"),
    })
  }

  const wake = () => {
    runAction({
      request: sdk().client.goal.wake({ sessionID: props.sessionID }),
      success: language.t("goal.toast.wakeSuccess.title"),
      failure: language.t("goal.toast.wakeFailed.title"),
    })
  }

  const clear = () => {
    runAction({
      request: sdk().client.goal.clear({ sessionID: props.sessionID }),
      success: language.t("goal.toast.clearSuccess.title"),
      failure: language.t("goal.toast.clearFailed.title"),
    })
  }

  const showClearConfirm = () => {
    dialog.show(() => (
      <Dialog title={language.t("goal.dock.clearConfirm.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <span class="text-14-regular text-text-strong">{language.t("goal.dock.clearConfirm.description")}</span>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="large"
              onClick={() => {
                clear()
                dialog.close()
              }}
            >
              {language.t("goal.dock.clear")}
            </Button>
          </div>
        </div>
      </Dialog>
    ))
  }

  const setBudget = (tokenBudget: number) => {
    const current = goal()
    if (!current) return
    runAction({
      request: sdk().client.goal.patchBudget({
        sessionID: props.sessionID,
        expectedGoalID: current.goalID,
        tokenBudget,
      }),
      success: language.t("goal.toast.budgetUpdated.title"),
      failure: language.t("goal.toast.budgetFailed.title"),
    })
  }

  const clearBudget = () => {
    const current = goal()
    if (!current) return
    runAction({
      request: sdk().client.goal.clearBudget({
        sessionID: props.sessionID,
        expectedGoalID: current.goalID,
      }),
      success: language.t("goal.toast.budgetUpdated.title"),
      failure: language.t("goal.toast.budgetFailed.title"),
    })
  }

  const showBudget = () => {
    dialog.show(() => <BudgetDialog current={goal()?.tokenBudget} onSave={setBudget} onClear={clearBudget} />)
  }

  const disableLesson = (lessonID: string) => {
    runAction({
      request: sdk().client.goal.disableLesson({ sessionID: props.sessionID, lessonID }),
      success: language.t("goal.toast.lessonDisabled.title"),
      failure: language.t("goal.toast.lessonDisableFailed.title"),
    })
  }

  const deleteLesson = (lessonID: string) => {
    runAction({
      request: sdk().client.goal.deleteLesson({ sessionID: props.sessionID, lessonID }),
      success: language.t("goal.toast.lessonDeleted.title"),
      failure: language.t("goal.toast.lessonDeleteFailed.title"),
    })
  }

  return (
    <>
      <Show when={error() && !data()}>
        <DockTray data-component="session-goal-dock-error">
          <div class="px-3 py-2 flex items-center gap-2">
            <span class="text-13-regular text-text-weak">{language.t("goal.dock.loadFailed")}</span>
            <Button size="small" variant="ghost" onClick={() => void load()}>
              {language.t("goal.dock.retry")}
            </Button>
          </div>
        </DockTray>
      </Show>
      <Show when={goal()} keyed>
        {(current) => (
          <DockTray data-component="session-goal-dock">
            <div
              class="pl-3 pr-2 py-2 flex items-center gap-2"
              role="button"
              tabIndex={0}
              onClick={() => setCollapsed((value) => !value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return
                event.preventDefault()
                setCollapsed((value) => !value)
              }}
            >
              <span class="shrink-0 text-13-medium text-text-strong">{language.t("goal.dock.title")}</span>
              <span class="shrink-0 text-12-regular text-text-subtle">{statusLabel(current.status)}</span>
              <Show when={collapsed()}>
                <span class="min-w-0 flex-1 truncate text-13-regular text-text-base">{current.outcome}</span>
              </Show>
              <div class="ml-auto flex items-center gap-2 shrink-0">
                <span class="hidden sm:inline text-12-regular text-text-subtle">
                  {language.t("goal.dock.contextTokens", { tokens: contextTokens() })}
                </span>
                <span class="hidden sm:inline text-12-regular text-text-subtle">{tokens()}</span>
                <span class="hidden sm:inline text-12-regular text-text-subtle">{elapsed()}</span>
                <Show when={activeLessons().length > 0}>
                  <span class="text-12-regular text-text-subtle">
                    {language.t("goal.dock.lessonsCount", { count: activeLessons().length })}
                  </span>
                </Show>
                <IconButton
                  icon="chevron-down"
                  size="normal"
                  variant="ghost"
                  style={{ transform: `rotate(${collapsed() ? 180 : 0}deg)` }}
                  onClick={(event) => {
                    event.stopPropagation()
                    setCollapsed((value) => !value)
                  }}
                  aria-label={collapsed() ? language.t("session.todo.expand") : language.t("session.todo.collapse")}
                />
              </div>
            </div>

            <div class="px-3 pb-2 flex items-center gap-2 flex-wrap">
              <Show when={current.status === "active"}>
                <Button size="small" variant="secondary" onClick={pause}>
                  {language.t("goal.dock.pause")}
                </Button>
              </Show>
              <Show when={["paused", "blocked", "usage_limited"].includes(current.status)}>
                <Button size="small" variant="secondary" onClick={resume}>
                  {language.t("goal.dock.resume")}
                </Button>
              </Show>
              <Show when={current.status === "active" && !working()}>
                <Button size="small" variant="secondary" onClick={wake}>
                  {language.t("goal.dock.wake")}
                </Button>
              </Show>
              <Show when={current.status === "budget_limited"}>
                <span class="text-12-regular text-text-weak">{language.t("goal.dock.budgetHint")}</span>
              </Show>
              <Button size="small" variant="ghost" onClick={showBudget}>
                {language.t("goal.dock.budget")}
              </Button>
              <Button size="small" variant="ghost" onClick={showClearConfirm}>
                {language.t("goal.dock.clear")}
              </Button>
            </div>

            <Show when={error()}>
              <div class="px-3 pb-2 flex items-center gap-2">
                <span class="text-12-regular text-text-weak">{language.t("goal.dock.refreshFailed")}</span>
                <Button size="small" variant="ghost" onClick={() => void load()}>
                  {language.t("goal.dock.retry")}
                </Button>
              </div>
            </Show>

            <Show when={!collapsed()}>
              <div class="px-3 pb-4 flex flex-col gap-4 max-h-72 overflow-y-auto no-scrollbar">
                <GoalContract goal={current} />
                <GoalLessons lessons={lessons()} onDisable={disableLesson} onDelete={deleteLesson} />
              </div>
            </Show>
          </DockTray>
        )}
      </Show>
    </>
  )
}

function GoalContract(props: { goal: SessionGoal }) {
  const language = useLanguage()
  const section = (label: string, items: string[] | undefined): JSX.Element => (
    <Show when={items?.length}>
      <div class="flex flex-col gap-1">
        <span class="text-12-medium text-text-subtle">{label}</span>
        <For each={items}>{(item) => <span class="text-13-regular text-text-base">{item}</span>}</For>
      </div>
    </Show>
  )

  return (
    <div class="flex flex-col gap-2">
      <span class="text-13-medium text-text-strong">{language.t("goal.dock.contract")}</span>
      {section(language.t("goal.dock.outcome"), [props.goal.outcome])}
      {section(language.t("goal.dock.verification"), props.goal.verification)}
      {section(language.t("goal.dock.constraints"), props.goal.constraints)}
      {section(language.t("goal.dock.boundaries"), props.goal.boundaries)}
      {section(language.t("goal.dock.iterationPolicy"), [props.goal.iterationPolicy])}
      {section(
        language.t("goal.dock.blockedCondition"),
        props.goal.blockedCondition ? [props.goal.blockedCondition] : undefined,
      )}
    </div>
  )
}

function GoalLessons(props: {
  lessons: SessionGoalLesson[]
  onDisable: (lessonID: string) => void
  onDelete: (lessonID: string) => void
}) {
  const language = useLanguage()
  return (
    <Show when={props.lessons.length > 0}>
      <div class="flex flex-col gap-2">
        <span class="text-13-medium text-text-strong">{language.t("goal.dock.lessons")}</span>
        <For each={props.lessons}>
          {(lesson) => (
            <div class="flex flex-col gap-1 border-t border-border-weaker-base pt-2">
              <div class="flex items-start gap-2">
                <span class="min-w-0 flex-1 text-13-regular text-text-base">{lesson.attempt}</span>
                <Show when={!lesson.disabledAt} fallback={<span class="text-11-regular text-text-weak">{language.t("goal.dock.lesson.disabled")}</span>}>
                  <Button size="small" variant="ghost" onClick={() => props.onDisable(lesson.id)}>
                    {language.t("goal.dock.lesson.disable")}
                  </Button>
                </Show>
                <Button size="small" variant="ghost" onClick={() => props.onDelete(lesson.id)}>
                  {language.t("goal.dock.lesson.delete")}
                </Button>
              </div>
              <span class="text-12-regular text-text-base">
                <span class="text-text-subtle">{language.t("goal.dock.lesson.observed")}: </span>
                {lesson.observed}
              </span>
              <span class="text-12-regular text-text-base">
                <span class="text-text-subtle">{language.t("goal.dock.lesson.implication")}: </span>
                {lesson.implication}
              </span>
              <Show when={lesson.evidence.length > 0}>
                <span class="text-12-regular text-text-weak">
                  <span class="text-text-subtle">{language.t("goal.dock.lesson.evidence")}: </span>
                  <For each={lesson.evidence}>
                    {(evidence, index) => (
                      <>
                        <Show when={index() > 0}>, </Show>
                        {evidence.tool}/{evidence.callID}
                      </>
                    )}
                  </For>
                </span>
              </Show>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

function BudgetDialog(props: { current: number | undefined; onSave: (budget: number) => void; onClear: () => void }) {
  const language = useLanguage()
  const dialog = useDialog()
  const [value, setValue] = createSignal(props.current?.toString() ?? "")
  const budget = createMemo(() => {
    const raw = value().trim()
    if (!raw) return undefined
    const parsed = Number(raw)
    if (!Number.isInteger(parsed) || parsed <= 0) return undefined
    return parsed
  })

  return (
    <Dialog title={language.t("goal.budget.title")} class="w-full max-w-[400px] mx-auto">
      <div class="flex flex-col gap-4 p-6 pt-0">
        <span class="text-14-regular text-text-base">{language.t("goal.budget.description")}</span>
        <TextField
          autofocus
          type="text"
          value={value()}
          onChange={setValue}
          placeholder={language.t("goal.budget.placeholder")}
          error={value().trim() && !budget() ? language.t("goal.budget.invalid") : undefined}
        />
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            variant="ghost"
            size="large"
            onClick={() => {
              props.onClear()
              dialog.close()
            }}
          >
            {language.t("goal.budget.clear")}
          </Button>
          <Button
            variant="primary"
            size="large"
            disabled={!budget()}
            onClick={() => {
              const next = budget()
              if (!next) return
              props.onSave(next)
              dialog.close()
            }}
          >
            {language.t("goal.budget.save")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
