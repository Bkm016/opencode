import type { SkillCloudStatus, SkillV2Info } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { List } from "@opencode-ai/ui/list"
import { Tabs } from "@opencode-ai/ui/tabs"
import { Tag } from "@opencode-ai/ui/tag"
import { TextField } from "@opencode-ai/ui/text-field"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { createMemo, createResource, For, Show, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { isPathInside } from "@/utils/path-key"
import { showToast } from "@/utils/toast"

function isProjectSkill(skill: SkillV2Info, directory: string) {
  if (skill.location === "<built-in>") return false
  return isPathInside(directory, skill.location)
}

// 内置技能（<built-in>）永久置顶，同层级按名称字母顺序排序
function compareSkills(a: SkillV2Info, b: SkillV2Info) {
  const aBuiltin = a.location === "<built-in>"
  const bBuiltin = b.location === "<built-in>"
  if (aBuiltin !== bBuiltin) return aBuiltin ? -1 : 1
  return a.name.localeCompare(b.name)
}

function skillKey(skill: SkillV2Info) {
  return JSON.stringify([skill.location, skill.name])
}

function errorMessage(error: unknown, fallback: string) {
  if (typeof error === "object" && error !== null && "data" in error) {
    const data = (error as { data?: unknown }).data
    if (typeof data === "object" && data !== null && "message" in data) {
      const message = (data as { message?: unknown }).message
      if (typeof message === "string" && message) return message
    }
  }
  if (error instanceof Error && error.message) return error.message
  return fallback
}

export function DialogSkills(props: { directory: string }) {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const platform = usePlatform()
  const server = useServer()
  const [store, setStore] = createStore({
    tab: "project",
    selected: undefined as string | undefined,
    // 仓库表单状态
    formOpen: false,
    formName: "",
    formRepository: "",
    editingName: undefined as string | undefined,
    action: undefined as string | undefined,
    reposExpanded: true,
  })

  const [skills, { refetch }] = createResource(
    () => props.directory,
    async (directory) => {
      const result = await serverSDK().client.app.skills({ directory })
      if (result.error) throw new Error(language.t("dialog.skills.loadError"))
      return (result.data ?? []).sort(compareSkills)
    },
  )

  const [cloudList, { mutate: mutateCloudList, refetch: refetchCloudList }] = createResource(
    () => serverSDK().client,
    async (client) => {
      const api = client.v2.skillCloud
      if (!api) throw new Error(language.t("dialog.skills.cloud.sdkRestart"))
      const result = await api.list()
      if (result.error || !result.data) {
        throw new Error(errorMessage(result.error, language.t("dialog.skills.cloud.error")))
      }
      return result.data
    },
  )

  const isCloudSkill = (skill: SkillV2Info) => {
    if (skill.location === "<built-in>") return false
    const repos = cloudList.latest
    if (repos && repos.length > 0) {
      return repos.some((repo) => isPathInside(repo.directory, skill.location))
    }
    const normalized = skill.location.replaceAll("\\", "/")
    return normalized.includes("/skills/cloud/")
  }

  const projectSkills = createMemo(() => (skills() ?? []).filter((skill) => isProjectSkill(skill, props.directory)))

  const cloudSkills = createMemo(() => (skills() ?? []).filter((skill) => isCloudSkill(skill)))

  const globalSkills = createMemo(() =>
    (skills() ?? []).filter(
      (skill) =>
        !isProjectSkill(skill, props.directory) &&
        !isCloudSkill(skill),
    ),
  )

  const skillRepo = (skill: SkillV2Info) => {
    const repos = cloudList.latest ?? []
    return repos.find((repo) => isPathInside(repo.directory, skill.location))
  }

  const selected = createMemo(() => {
    if (!store.selected) return
    const items = store.tab === "project" ? projectSkills() : store.tab === "cloud" ? cloudSkills() : globalSkills()
    return items.find((skill) => skillKey(skill) === store.selected)
  })

  const repoStateText = (state: SkillCloudStatus["state"]) => {
    switch (state) {
      case "ready":
        return language.t("dialog.skills.cloud.state.ready")
      case "modified":
        return language.t("dialog.skills.cloud.state.modified")
      case "ahead":
        return language.t("dialog.skills.cloud.state.ahead")
      case "behind":
        return language.t("dialog.skills.cloud.state.behind")
      case "diverged":
        return language.t("dialog.skills.cloud.state.diverged")
      default:
        return language.t("dialog.skills.cloud.state.unconfigured")
    }
  }

  const handleConfigure = async () => {
    if (store.action) return
    const repository = store.formRepository.trim()
    if (!repository) return
    const name = store.formName.trim() || undefined

    setStore("action", "configure")
    try {
      const client = serverSDK().client
      const api = client.v2.skillCloud
      if (!api) throw new Error(language.t("dialog.skills.cloud.sdkRestart"))
      const result = await api.configure({
        skillCloudConfigureInput: { repository, name },
      })
      if (result.error || !result.data) {
        throw new Error(errorMessage(result.error, language.t("dialog.skills.cloud.error")))
      }

      const refreshed = await api.list()
      if (refreshed.data) mutateCloudList(refreshed.data)

      setStore({
        formOpen: false,
        formName: "",
        formRepository: "",
        editingName: undefined,
      })

      const reload = await client.instance.reload({ directory: props.directory })
      if (reload.error) throw new Error(language.t("dialog.skills.loadError"))
      await refetch()
      showToast({ title: language.t("dialog.skills.cloud.toast.configured") })
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("dialog.skills.cloud.error"),
        description: errorMessage(error, language.t("dialog.skills.cloud.error")),
      })
    } finally {
      setStore("action", undefined)
    }
  }

  const handleUpdate = async (name?: string) => {
    if (store.action) return
    const actionKey = name ? `update:${name}` : "update-all"
    setStore("action", actionKey)

    try {
      const client = serverSDK().client
      const api = client.v2.skillCloud
      if (!api) throw new Error(language.t("dialog.skills.cloud.sdkRestart"))
      const result = await api.update({ skillCloudUpdateInput: { name } })
      if (result.error || !result.data) {
        throw new Error(errorMessage(result.error, language.t("dialog.skills.cloud.error")))
      }

      const refreshed = await api.list()
      if (refreshed.data) mutateCloudList(refreshed.data)

      const reload = await client.instance.reload({ directory: props.directory })
      if (reload.error) throw new Error(language.t("dialog.skills.loadError"))
      await refetch()
      showToast({ title: language.t("dialog.skills.cloud.toast.updated") })
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("dialog.skills.cloud.error"),
        description: errorMessage(error, language.t("dialog.skills.cloud.error")),
      })
    } finally {
      setStore("action", undefined)
    }
  }

  const handleSync = async (name: string) => {
    if (store.action) return
    setStore("action", `sync:${name}`)

    try {
      const client = serverSDK().client
      const api = client.v2.skillCloud
      if (!api) throw new Error(language.t("dialog.skills.cloud.sdkRestart"))
      const result = await api.sync({ skillCloudSyncInput: { name } })
      if (result.error || !result.data) {
        throw new Error(errorMessage(result.error, language.t("dialog.skills.cloud.error")))
      }

      const refreshed = await api.list()
      if (refreshed.data) mutateCloudList(refreshed.data)

      const reload = await client.instance.reload({ directory: props.directory })
      if (reload.error) throw new Error(language.t("dialog.skills.loadError"))
      await refetch()
      showToast({ title: language.t("dialog.skills.cloud.toast.synced") })
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("dialog.skills.cloud.error"),
        description: errorMessage(error, language.t("dialog.skills.cloud.error")),
      })
    } finally {
      setStore("action", undefined)
    }
  }

  const handleRemove = async (name: string) => {
    if (store.action) return
    const confirmed = window.confirm(language.t("dialog.skills.cloud.delete.confirm", { name }))
    if (!confirmed) return

    setStore("action", `remove:${name}`)
    try {
      const client = serverSDK().client
      const api = client.v2.skillCloud
      if (!api) throw new Error(language.t("dialog.skills.cloud.sdkRestart"))
      const result = await api.remove({ skillCloudRemoveInput: { name } })
      if (result.error || !result.data) {
        throw new Error(errorMessage(result.error, language.t("dialog.skills.cloud.error")))
      }

      mutateCloudList(result.data)
      const reload = await client.instance.reload({ directory: props.directory })
      if (reload.error) throw new Error(language.t("dialog.skills.loadError"))
      await refetch()
      showToast({ title: language.t("dialog.skills.cloud.toast.deleted") })
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("dialog.skills.cloud.error"),
        description: errorMessage(error, language.t("dialog.skills.cloud.error")),
      })
    } finally {
      setStore("action", undefined)
    }
  }

  const startEdit = (repo: SkillCloudStatus) => {
    setStore({
      formOpen: true,
      formName: repo.name,
      formRepository: repo.repository ?? "",
      editingName: repo.name,
      reposExpanded: true,
    })
  }

  const startAdd = () => {
    setStore({
      formOpen: true,
      formName: "",
      formRepository: "",
      editingName: undefined,
      reposExpanded: true,
    })
  }

  const cancelForm = () => {
    setStore({
      formOpen: false,
      formName: "",
      formRepository: "",
      editingName: undefined,
    })
  }

  // 仅桌面端且连接本地服务时支持调用系统外部编辑器打开技能文件
  const canOpenFile = createMemo(() => !!platform.openPath && server.isLocal())

  // 双击或点击按钮在本地编辑器中打开技能源文件，内置技能提示不可编辑
  const handleOpenSkill = async (skill: SkillV2Info) => {
    setStore("selected", skillKey(skill))
    if (skill.location === "<built-in>") {
      showToast({
        title: language.t("dialog.skills.builtinCannotEdit"),
      })
      return
    }
    if (!canOpenFile() || !platform.openPath) return

    try {
      await platform.openPath(skill.location)
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("dialog.skills.openError"),
        description: errorMessage(error, language.t("dialog.skills.openError")),
      })
    }
  }

  const list = (items: Accessor<SkillV2Info[]>, emptyMessage: string, showRepoTag = false) => (
    <List
      class="h-full px-3 pb-3"
      search={{
        placeholder: language.t("dialog.skills.search.placeholder"),
        autofocus: true,
      }}
      emptyMessage={emptyMessage}
      key={skillKey}
      items={items}
      filterKeys={["name", "description", "location"]}
      sortBy={compareSkills}
      onSelect={(skill) => setStore("selected", skill ? skillKey(skill) : undefined)}
      onDblClick={(skill) => void handleOpenSkill(skill)}
    >
      {(skill) => {
        const repo = showRepoTag ? skillRepo(skill) : undefined
        return (
          <div
            class="flex flex-col gap-0.5 min-w-0 w-full py-1 text-left"
            onDblClick={(event) => {
              event.stopPropagation()
              void handleOpenSkill(skill)
            }}
          >
            <div class="flex items-center gap-1.5 min-w-0">
              <span class="truncate text-14-medium text-text-strong">{skill.name}</span>
              <Show when={skill.location === "<built-in>"}>
                <span class="shrink-0 text-10-regular font-mono text-text-subtle px-1 rounded bg-surface-base border border-border-weak-base/50">
                  built-in
                </span>
              </Show>
              <Show when={repo}>
                <span class="shrink-0 text-10-regular font-mono text-text-subtle px-1 rounded bg-surface-base border border-border-weak-base/50">
                  {repo!.name}
                </span>
              </Show>
            </div>
            <Show when={skill.description}>
              {(description) => <span class="truncate text-12-regular text-text-base">{description()}</span>}
            </Show>
            <span class="truncate text-11-regular text-text-weak" title={skill.location}>
              {skill.location}
            </span>
          </div>
        )
      }}
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
              <Tabs.Trigger value="cloud">
                {language.t("dialog.skills.scope.cloud")} ({cloudSkills().length})
              </Tabs.Trigger>
            </Tabs.List>

            <Show when={store.tab === "cloud"}>
              <div class="border-b border-border-weak-base bg-surface-raised-base/20 px-4 py-2.5 sm:px-5 flex flex-col gap-2 shrink-0">
                {/* 顶部工具栏 */}
                <div class="flex items-center justify-between gap-3 min-h-[30px]">
                  <button
                    type="button"
                    class="flex items-center gap-1.5 hover:opacity-80 transition-opacity cursor-pointer text-left select-none -ml-1 pl-1 py-0.5 rounded"
                    onClick={() => setStore("reposExpanded", (v) => !v)}
                  >
                    <Icon
                      name="chevron-down"
                      classList={{
                        "w-3.5 h-3.5 text-text-weak transition-transform duration-150 shrink-0": true,
                        "-rotate-90": !store.reposExpanded && !store.formOpen,
                      }}
                    />
                    <Icon name="cloud-upload" class="w-4 h-4 text-text-weak shrink-0" />
                    <span class="text-13-medium text-text-strong">
                      {language.t("dialog.skills.cloud.repository")}
                    </span>
                    <span class="text-11-regular text-text-subtle font-mono">
                      ({cloudList.latest?.length ?? 0})
                    </span>
                  </button>

                  <div class="flex items-center gap-1.5">
                    <Show when={(cloudList.latest?.length ?? 0) > 1}>
                      <Button
                        size="small"
                        variant="ghost"
                        icon="download"
                        disabled={!!store.action}
                        onClick={() => void handleUpdate()}
                      >
                        {store.action === "update-all"
                          ? language.t("common.loading")
                          : language.t("dialog.skills.cloud.updateAll")}
                      </Button>
                    </Show>
                    <Show when={!store.formOpen}>
                      <Button
                        size="small"
                        variant="secondary"
                        icon="plus-small"
                        disabled={!!store.action}
                        onClick={startAdd}
                      >
                        {language.t("dialog.skills.cloud.add")}
                      </Button>
                    </Show>
                  </div>
                </div>

                {/* 错误提示 */}
                <Show when={cloudList.error}>
                  <div class="flex items-center justify-between gap-3 text-12-regular text-text-weak py-0.5">
                    <div class="flex items-center gap-2 text-text-critical">
                      <Icon name="warning" class="w-4 h-4 shrink-0" />
                      <span class="truncate">{errorMessage(cloudList.error, language.t("dialog.skills.cloud.error"))}</span>
                    </div>
                    <Button size="small" variant="ghost" onClick={() => void refetchCloudList()}>
                      {language.t("dialog.skills.retry")}
                    </Button>
                  </div>
                </Show>

                {/* 添加/编辑仓库表单 */}
                <Show when={store.formOpen}>
                  <div class="flex flex-col gap-2 p-3 rounded-md bg-surface-base border border-border-weak-base">
                    <div class="flex items-center justify-between">
                      <span class="text-12-medium text-text-strong">
                        {store.editingName
                          ? `${language.t("dialog.skills.cloud.edit")} (${store.editingName})`
                          : language.t("dialog.skills.cloud.add")}
                      </span>
                      <Button size="small" variant="ghost" onClick={cancelForm}>
                        {language.t("common.cancel")}
                      </Button>
                    </div>

                    <div class="flex flex-col sm:flex-row items-center gap-2">
                      <div class="w-full sm:w-36 shrink-0">
                        <TextField
                          class="w-full"
                          hideLabel
                          label={language.t("dialog.skills.cloud.name")}
                          placeholder={language.t("dialog.skills.cloud.name.placeholder")}
                          value={store.formName}
                          disabled={!!store.action || !!store.editingName}
                          onChange={(value) => setStore("formName", value)}
                          onKeyDown={(event: KeyboardEvent) => {
                            if (event.key === "Enter") void handleConfigure()
                          }}
                        />
                      </div>
                      <div class="flex-1 min-w-0 w-full">
                        <TextField
                          class="w-full"
                          hideLabel
                          label={language.t("dialog.skills.cloud.repository")}
                          placeholder={language.t("dialog.skills.cloud.repository.placeholder")}
                          value={store.formRepository}
                          disabled={!!store.action}
                          onChange={(value) => setStore("formRepository", value)}
                          onKeyDown={(event: KeyboardEvent) => {
                            if (event.key === "Enter") void handleConfigure()
                          }}
                        />
                      </div>
                      <Button
                        size="small"
                        variant="secondary"
                        disabled={!!store.action || !store.formRepository.trim()}
                        onClick={() => void handleConfigure()}
                      >
                        {store.action === "configure"
                          ? language.t("common.loading")
                          : store.editingName
                            ? language.t("dialog.skills.cloud.save")
                            : language.t("dialog.skills.cloud.connect")}
                      </Button>
                    </div>
                  </div>
                </Show>

                {/* 仓库列表卡片组 */}
                <Show when={store.reposExpanded || store.formOpen}>
                  <Show
                    when={!cloudList.loading || (cloudList.latest?.length ?? 0) > 0}
                    fallback={
                      <div class="flex items-center gap-2 py-2 px-1 text-12-regular text-text-subtle">
                        <span class="w-2 h-2 rounded-full bg-text-subtle/50 animate-pulse" />
                        <span>{language.t("common.loading")}</span>
                      </div>
                    }
                  >
                    <Show
                      when={(cloudList.latest?.length ?? 0) > 0}
                      fallback={
                        <Show when={!store.formOpen}>
                          <div class="flex items-center justify-between py-1 text-12-regular text-text-subtle">
                            <span>{language.t("dialog.skills.cloud.empty")}</span>
                          </div>
                        </Show>
                      }
                    >
                    <div class="flex flex-col gap-1.5 max-h-[115px] overflow-y-auto pr-1">
                      <For each={cloudList.latest}>
                        {(repo) => {
                          const isSyncing = () => store.action === `sync:${repo.name}`
                          const isUpdating = () => store.action === `update:${repo.name}`
                          const isRemoving = () => store.action === `remove:${repo.name}`

                          return (
                            <div class="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded bg-surface-base/70 border border-border-weak-base/50 min-h-[32px] group">
                              {/* 左侧：状态与元信息 */}
                              <div class="flex min-w-0 flex-1 items-center gap-2">
                                <span
                                  classList={{
                                    "w-2 h-2 rounded-full shrink-0": true,
                                    "bg-text-subtle/50": !repo.configured,
                                    "bg-emerald-500": repo.state === "ready",
                                    "bg-amber-500": repo.state === "modified" || repo.state === "ahead",
                                    "bg-sky-500": repo.state === "behind",
                                    "bg-red-500": repo.state === "diverged",
                                  }}
                                />
                                <span class="text-12-medium text-text-strong font-mono shrink-0">{repo.name}</span>
                                <span class="text-11-regular text-text-weak shrink-0">{repoStateText(repo.state)}</span>
                                <Show when={repo.branch}>
                                  {(branch) => (
                                    <Tag class="text-10-regular text-text-weak bg-surface-base border-border-base/50 flex items-center gap-1 shrink-0">
                                      <Icon name="branch" class="w-3 h-3 text-text-subtle" />
                                      <span>{branch()}</span>
                                    </Tag>
                                  )}
                                </Show>
                                <Show when={repo.changes}>
                                  {(count) => (
                                    <Tag class="text-10-regular text-amber-500 bg-surface-base border-amber-500/30 shrink-0">
                                      {language.t("dialog.skills.cloud.changes", { count: count() })}
                                    </Tag>
                                  )}
                                </Show>
                                <Show when={repo.ahead}>
                                  {(count) => (
                                    <Tag class="text-10-regular text-sky-400 bg-surface-base border-sky-500/30 shrink-0">
                                      {language.t("dialog.skills.cloud.ahead", { count: count() })}
                                    </Tag>
                                  )}
                                </Show>
                                <Show when={repo.behind}>
                                  {(count) => (
                                    <Tag class="text-10-regular text-sky-400 bg-surface-base border-sky-500/30 shrink-0">
                                      {language.t("dialog.skills.cloud.behind", { count: count() })}
                                    </Tag>
                                  )}
                                </Show>
                                <Show when={repo.repository}>
                                  {(remoteUrl) => (
                                    <span class="truncate text-11-regular font-mono text-text-subtle max-w-[200px]" title={remoteUrl()}>
                                      {remoteUrl()}
                                    </span>
                                  )}
                                </Show>
                              </div>

                              {/* 右侧：单仓库操作按钮组 */}
                              <div class="flex shrink-0 items-center gap-0.5">
                                <IconButton
                                  icon="download"
                                  size="small"
                                  variant="ghost"
                                  title={language.t("dialog.skills.cloud.update")}
                                  disabled={!!store.action || !repo.configured}
                                  onClick={() => void handleUpdate(repo.name)}
                                />
                                <IconButton
                                  icon="cloud-upload"
                                  size="small"
                                  variant="ghost"
                                  title={language.t("dialog.skills.cloud.sync")}
                                  disabled={!!store.action || !repo.configured}
                                  onClick={() => void handleSync(repo.name)}
                                />
                                <IconButton
                                  icon="edit-small-2"
                                  size="small"
                                  variant="ghost"
                                  title={language.t("dialog.skills.cloud.edit")}
                                  disabled={!!store.action}
                                  onClick={() => startEdit(repo)}
                                />
                                <IconButton
                                  icon="trash"
                                  size="small"
                                  variant="ghost"
                                  title={language.t("dialog.skills.cloud.delete.title")}
                                  disabled={!!store.action}
                                  onClick={() => void handleRemove(repo.name)}
                                />
                              </div>
                            </div>
                          )
                        }}
                      </For>
                    </div>
                  </Show>
                </Show>
              </Show>
            </div>
          </Show>

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
                <Tabs.Content value="cloud" class="pt-3 min-h-0">
                  {list(cloudSkills, language.t("dialog.skills.empty.cloud"), (cloudList.latest?.length ?? 0) > 1)}
                </Tabs.Content>
              </div>
              <Show
                when={selected()}
                keyed
                fallback={
                  <div class="hidden sm:flex flex-1 items-center justify-center px-8 text-center">
                    <span class="text-14-regular text-text-weak">{language.t("dialog.skills.select")}</span>
                  </div>
                }
              >
                {(skill) => (
                  <div class="flex flex-1 min-w-0 flex-col overflow-y-auto no-scrollbar">
                    <div class="sticky top-0 z-10 flex items-start gap-3 border-b border-border-weak-base bg-surface-raised-stronger-non-alpha px-5 py-4">
                      <Button variant="ghost" size="small" class="sm:hidden" onClick={() => setStore("selected", undefined)}>
                        {language.t("dialog.skills.back")}
                      </Button>
                      <div class="flex min-w-0 flex-1 flex-col gap-1">
                        <span class="text-16-medium text-text-strong">{skill.name}</span>
                        <Show when={skill.description}>
                          {(description) => <span class="text-13-regular text-text-base">{description()}</span>}
                        </Show>
                      </div>
                      <Show when={skill.location !== "<built-in>" && canOpenFile()}>
                        <Button
                          variant="ghost"
                          size="small"
                          class="shrink-0 flex items-center gap-1.5"
                          onClick={() => void handleOpenSkill(skill)}
                        >
                          <Icon name="edit" class="w-3.5 h-3.5" />
                          <span>{language.t("dialog.skills.openFile")}</span>
                        </Button>
                      </Show>
                    </div>
                    <div class="flex flex-col gap-5 px-5 py-4">
                      <div class="flex flex-col gap-1.5">
                        <span class="text-12-medium text-text-weak">{language.t("dialog.skills.source")}</span>
                        <span class="break-all text-12-regular text-text-base select-text">
                          {skill.location}
                        </span>
                      </div>
                      <div class="flex flex-col gap-2">
                        <span class="text-12-medium text-text-weak">{language.t("dialog.skills.instructions")}</span>
                        <div class="rounded-md border border-border-base bg-surface-base px-4 py-3 select-text">
                          <Markdown text={skill.content} cacheKey={skillKey(skill)} class="text-13-regular" />
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
