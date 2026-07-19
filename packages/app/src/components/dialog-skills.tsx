import type { SkillV2Info } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { Tabs } from "@opencode-ai/ui/tabs"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { createMediaQuery } from "@solid-primitives/media"
import { createEffect, createMemo, createResource, Show, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { isPathInside } from "@/utils/path-key"

function isProjectSkill(skill: SkillV2Info, directory: string) {
  if (skill.location === "<built-in>") return false
  return isPathInside(directory, skill.location)
}

export function DialogSkills(props: { directory: string }) {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const [store, setStore] = createStore({
    tab: "project",
    selected: undefined as SkillV2Info | undefined,
  })
  const [skills, { refetch }] = createResource(
    () => props.directory,
    async (directory) => {
      const result = await serverSDK().client.app.skills({ directory })
      if (result.error) throw new Error(language.t("dialog.skills.loadError"))
      return (result.data ?? []).sort((a, b) => a.name.localeCompare(b.name))
    },
  )
  const projectSkills = createMemo(() => (skills() ?? []).filter((skill) => isProjectSkill(skill, props.directory)))
  const globalSkills = createMemo(() => (skills() ?? []).filter((skill) => !isProjectSkill(skill, props.directory)))
  const desktop = createMediaQuery("(min-width: 640px)")

  createEffect(() => {
    if (!desktop()) return
    const items = store.tab === "project" ? projectSkills() : globalSkills()
    if (store.selected && items.includes(store.selected)) return
    // 桌面列表会默认激活首项，详情状态同步首项以保持左右两栏一致。
    setStore("selected", items[0])
  })

  const list = (items: Accessor<SkillV2Info[]>, emptyMessage: string) => (
    <List
      class="h-full px-3 pb-3"
      search={{
        placeholder: language.t("dialog.skills.search.placeholder"),
        autofocus: true,
      }}
      emptyMessage={emptyMessage}
      key={(skill) => skill.location}
      items={items}
      filterKeys={["name", "description", "location"]}
      current={store.selected}
      onSelect={(skill) => setStore("selected", skill)}
    >
      {(skill) => (
        <div class="flex flex-col gap-0.5 min-w-0 w-full py-1 text-left">
          <span class="truncate text-14-medium text-text-strong">{skill.name}</span>
          <Show when={skill.description}>
            {(description) => <span class="truncate text-12-regular text-text-base">{description()}</span>}
          </Show>
          <span class="truncate text-11-regular text-text-weak" title={skill.location}>
            {skill.location}
          </span>
        </div>
      )}
    </List>
  )

  return (
    <Dialog
      size="x-large"
      title={language.t("dialog.skills.title")}
      description={language.t("dialog.skills.description")}
    >
      <Show
        when={!skills.error}
        fallback={
          <div class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <span class="text-14-regular text-text-weak">{language.t("dialog.skills.loadError")}</span>
            <Button size="small" onClick={() => void refetch()}>
              {language.t("dialog.skills.retry")}
            </Button>
          </div>
        }
      >
        <Show
          when={!skills.loading}
          fallback={
            <div class="flex flex-1 items-center justify-center px-6 text-center">
              <span class="text-14-regular text-text-weak">{language.t("common.loading")}</span>
            </div>
          }
        >
          <Tabs
            variant="alt"
            value={store.tab}
            onChange={(value) => {
              setStore({ tab: value, selected: undefined })
            }}
          >
            <Tabs.List>
              <Tabs.Trigger value="project">
                {language.t("dialog.skills.scope.project")} ({projectSkills().length})
              </Tabs.Trigger>
              <Tabs.Trigger value="global">
                {language.t("dialog.skills.scope.global")} ({globalSkills().length})
              </Tabs.Trigger>
            </Tabs.List>
            <div class="flex flex-1 min-h-0">
              <div
                classList={{
                  "flex flex-col flex-1 min-w-0 sm:flex-none sm:w-[320px] sm:border-r sm:border-border-weak-base": true,
                  "hidden sm:flex": !!store.selected,
                }}
              >
                <Tabs.Content value="project" class="pt-3 min-h-0">
                  {list(projectSkills, language.t("dialog.skills.empty.project"))}
                </Tabs.Content>
                <Tabs.Content value="global" class="pt-3 min-h-0">
                  {list(globalSkills, language.t("dialog.skills.empty.global"))}
                </Tabs.Content>
              </div>
              <Show
                when={store.selected}
                fallback={
                  <div class="hidden sm:flex flex-1 items-center justify-center px-8 text-center">
                    <span class="text-14-regular text-text-weak">{language.t("dialog.skills.select")}</span>
                  </div>
                }
              >
                {(skill) => (
                  <div class="flex flex-1 min-w-0 flex-col overflow-y-auto no-scrollbar">
                    <div class="sticky top-0 flex items-start gap-3 border-b border-border-weak-base bg-surface-raised-stronger-non-alpha px-5 py-4">
                      <Button variant="ghost" size="small" class="sm:hidden" onClick={() => setStore("selected", undefined)}>
                        {language.t("dialog.skills.back")}
                      </Button>
                      <div class="flex min-w-0 flex-1 flex-col gap-1">
                        <span class="text-16-medium text-text-strong">{skill().name}</span>
                        <Show when={skill().description}>
                          {(description) => <span class="text-13-regular text-text-base">{description()}</span>}
                        </Show>
                      </div>
                    </div>
                    <div class="flex flex-col gap-5 px-5 py-4">
                      <div class="flex flex-col gap-1.5">
                        <span class="text-12-medium text-text-weak">{language.t("dialog.skills.source")}</span>
                        <span class="break-all text-12-regular text-text-base select-text">{skill().location}</span>
                      </div>
                      <div class="flex flex-col gap-2">
                        <span class="text-12-medium text-text-weak">{language.t("dialog.skills.instructions")}</span>
                        <div class="rounded-md border border-border-base bg-surface-base px-4 py-3 select-text">
                          <Markdown text={skill().content} class="text-13-regular" />
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </Show>
            </div>
          </Tabs>
        </Show>
      </Show>
    </Dialog>
  )
}
