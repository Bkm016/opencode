import { Show, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import { SessionPermissionDock } from "@/pages/session/composer/session-permission-dock"
import { SessionQuestionDock } from "@/pages/session/composer/session-question-dock"
import { SessionFollowupDock } from "@/pages/session/composer/session-followup-dock"
import { SessionRevertDock } from "@/pages/session/composer/session-revert-dock"
import { SessionTodoPanel } from "@/pages/session/composer/session-todo-dock"
import { SessionGoalDock } from "@/pages/session/composer/session-goal-dock"
import { SessionShellJobsDock } from "@/pages/session/composer/session-shell-jobs-dock"
import { SessionAssistantDock } from "@/pages/session/composer/session-assistant-dock"
import {
  ComposerTabsProvider,
  SessionComposerTabs,
  createComposerTabs,
} from "@/pages/session/composer/session-composer-tabs"
import type { SessionComposerRegionController } from "./session-composer-region-controller"

export function SessionComposerRegion(props: {
  controller: SessionComposerRegionController
  promptInput: JSX.Element
}) {
  const language = useLanguage()
  const controller = props.controller
  const tabs = createComposerTabs()
  const rolled = () => {
    const revert = controller.revert()
    return revert?.items.length ? revert : undefined
  }
  const prompt = () => controller.promptReady() && !controller.state.blocked()

  // 将编辑器层级限制在页面内，避免子级 z-index 穿透并盖住全局弹窗。
  return (
    <div
      ref={controller.setDockRef}
      data-component="session-prompt-dock"
      class="relative z-40 w-full shrink-0 flex flex-col justify-center items-center pb-[max(10px,env(safe-area-inset-bottom))] md:pb-6 pointer-events-none bg-background-stronger"
    >
      <div
        classList={{
          "group/composer w-full px-2 md:px-3 pointer-events-auto": true,
          "md:max-w-200 md:mx-auto 2xl:max-w-[1000px]": controller.centered(),
        }}
        data-has-todo={controller.dock() ? "" : undefined}
      >
        <Show when={controller.state.questionRequest()} keyed>
          {(request) => (
            <div>
              <SessionQuestionDock request={request} onSubmit={controller.onResponseSubmit} />
            </div>
          )}
        </Show>

        <Show when={controller.state.permissionRequest()} keyed>
          {(request) => (
            <div>
              <SessionPermissionDock
                request={request}
                responding={controller.state.permissionResponding()}
                onDecide={(response) => {
                  controller.onResponseSubmit()
                  controller.state.decide(response)
                }}
              />
            </div>
          )}
        </Show>

        <Show when={controller.showComposer()}>
          <Show when={rolled()} keyed>
            {(revert) => (
              <div classList={{ "pb-2": !controller.promptReady() }}>
                <SessionRevertDock
                  items={revert.items}
                  restoring={revert.restoring}
                  disabled={revert.disabled}
                  onRestore={revert.onRestore}
                />
              </div>
            )}
          </Show>
          {/* 目标、待办、后台、助手、排队共用一座状态岛，标签切换，浮在输入框上方 */}
          <div
            classList={{
              "relative z-[70]": true,
            }}
            style={{
              "margin-top": `${controller.promptReady() ? -controller.lift() : 0}px`,
            }}
          >
            <ComposerTabsProvider value={tabs}>
              <SessionComposerTabs attached={prompt()}>
                <Show when={controller.sessionID()} keyed>
                  {(sessionID) => (
                    <>
                      <SessionGoalDock sessionID={sessionID} />
                      <SessionShellJobsDock sessionID={sessionID} />
                      <SessionAssistantDock sessionID={sessionID} />
                    </>
                  )}
                </Show>
                <SessionTodoPanel
                  todos={controller.state.todos()}
                  visible={controller.dock()}
                  onDismiss={controller.state.dismissTodos}
                  dismissLabel={language.t("common.close")}
                />
                <SessionFollowupDock
                  items={controller.followup()?.items ?? []}
                  sending={controller.followup()?.sending}
                  onSend={(id) => controller.followup()?.onSend(id)}
                  onEdit={(id) => controller.followup()?.onEdit(id)}
                  onDelete={(id) => controller.followup()?.onDelete(id)}
                />
              </SessionComposerTabs>
            </ComposerTabsProvider>
            <Show when={prompt()}>{props.promptInput}</Show>
          </div>
        </Show>
      </div>
    </div>
  )
}
