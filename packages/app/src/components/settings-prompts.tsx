import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tag } from "@opencode-ai/ui/tag"
import { TextField } from "@opencode-ai/ui/text-field"
import { useFilteredList } from "@opencode-ai/ui/hooks"
import { type Component, For, Show, createEffect, createMemo, createResource, createSignal, on } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { SettingsList } from "./settings-list"
import { SettingsServerPicker, SettingsServerScope } from "./settings-server-picker"

type PromptGroup = "system" | "agent" | "session" | "tool" | "command" | "compaction" | "runtime"

type PromptCatalogItem = {
  id: string
  group: PromptGroup
  title: string
  description: string
  default?: string
  value?: string
  overridden?: boolean
}

const GROUPS: PromptGroup[] = ["system", "agent", "session", "command", "tool", "compaction", "runtime"]

const GROUP_KEY: Record<PromptGroup, string> = {
  system: "settings.prompts.group.system",
  agent: "settings.prompts.group.agent",
  session: "settings.prompts.group.session",
  tool: "settings.prompts.group.tool",
  command: "settings.prompts.group.command",
  compaction: "settings.prompts.group.compaction",
  runtime: "settings.prompts.group.runtime",
}

// Mirrors packages/opencode/src/session/prompt-catalog.ts ENTRIES metadata when the API is unavailable.
const LOCAL_CATALOG: PromptCatalogItem[] = [
  {
    id: "system.default",
    group: "system",
    title: "Default system",
    description: "Provider system prompt for models without a specialized template",
  },
  {
    id: "system.anthropic",
    group: "system",
    title: "Anthropic / Claude",
    description: "System prompt when the model id includes claude",
  },
  {
    id: "system.gpt",
    group: "system",
    title: "GPT",
    description: "System prompt for gpt models (non-codex)",
  },
  {
    id: "system.beast",
    group: "system",
    title: "GPT-4 / o1 / o3",
    description: "System prompt for gpt-4, o1, and o3 models",
  },
  {
    id: "system.codex",
    group: "system",
    title: "Codex",
    description: "System prompt when the model id includes codex",
  },
  {
    id: "system.gemini",
    group: "system",
    title: "Gemini",
    description: "System prompt when the model id includes gemini-",
  },
  {
    id: "system.kimi",
    group: "system",
    title: "Kimi",
    description: "System prompt when the model id includes kimi",
  },
  {
    id: "system.meta",
    group: "system",
    title: "Meta / Muse Spark",
    description: "System prompt when the model id includes muse-spark",
  },
  {
    id: "system.trinity",
    group: "system",
    title: "Trinity",
    description: "System prompt when the model id includes trinity",
  },
  {
    id: "agent.build",
    group: "agent",
    title: "Build agent",
    description: "Default primary agent system prompt (used when agent.prompt is set)",
  },
  {
    id: "agent.explore",
    group: "agent",
    title: "Explore agent",
    description: "Subagent specialized for codebase search",
  },
  {
    id: "agent.compaction",
    group: "agent",
    title: "Compaction agent",
    description: "Hidden agent system prompt for context compaction",
  },
  {
    id: "agent.title",
    group: "agent",
    title: "Title agent",
    description: "Hidden agent that generates session titles",
  },
  {
    id: "agent.summary",
    group: "agent",
    title: "Summary agent",
    description: "Hidden agent that summarizes completed work",
  },
  {
    id: "agent.generate",
    group: "agent",
    title: "Generate agent config",
    description: "Prompt used when creating a new agent configuration from a description",
  },
  {
    id: "session.plan",
    group: "session",
    title: "Plan mode injection",
    description: "Synthetic user text injected while the plan agent is active",
  },
  {
    id: "session.plan_mode",
    group: "session",
    title: "Plan mode (experimental)",
    description: "Experimental plan-mode body; supports ${planInfo}",
  },
  {
    id: "session.build_switch",
    group: "session",
    title: "Plan → build switch",
    description: "Synthetic text injected when leaving plan agent for build",
  },
  {
    id: "command.init",
    group: "command",
    title: "/init command",
    description: "Built-in initialize command template; supports ${path}",
  },
  {
    id: "command.review",
    group: "command",
    title: "/review command",
    description: "Built-in review command template; supports ${path}",
  },
  { id: "tool.read", group: "tool", title: "read", description: "Tool description for the read tool" },
  { id: "tool.write", group: "tool", title: "write", description: "Tool description for the write tool" },
  { id: "tool.edit", group: "tool", title: "edit", description: "Tool description for the edit tool" },
  { id: "tool.grep", group: "tool", title: "grep", description: "Tool description for the grep tool" },
  { id: "tool.glob", group: "tool", title: "glob", description: "Tool description for the glob tool" },
  { id: "tool.task", group: "tool", title: "task", description: "Tool description for the task tool" },
  { id: "tool.skill", group: "tool", title: "skill", description: "Tool description for the skill tool" },
  { id: "tool.question", group: "tool", title: "question", description: "Tool description for the question tool" },
  { id: "tool.lsp", group: "tool", title: "lsp", description: "Tool description for the lsp tool" },
  { id: "tool.webfetch", group: "tool", title: "webfetch", description: "Tool description for the webfetch tool" },
  { id: "tool.websearch", group: "tool", title: "websearch", description: "Tool description for the websearch tool" },
  {
    id: "tool.todowrite",
    group: "tool",
    title: "todowrite",
    description: "Tool description for the todowrite tool",
  },
  {
    id: "tool.apply_patch",
    group: "tool",
    title: "apply_patch",
    description: "Tool description for the apply_patch tool",
  },
  {
    id: "tool.plan_exit",
    group: "tool",
    title: "plan_exit",
    description: "Tool description for the plan_exit tool",
  },
  {
    id: "tool.bash",
    group: "tool",
    title: "bash / shell",
    description: "Shell tool description template (supports placeholder tokens from the shell renderer)",
  },
  {
    id: "compaction.template",
    group: "compaction",
    title: "Compaction summary template",
    description: "Markdown structure the compaction model must follow",
  },
  {
    id: "compaction.fresh_intro",
    group: "compaction",
    title: "Compaction fresh intro",
    description: "User prompt intro when there is no previous summary",
  },
  {
    id: "compaction.update_intro",
    group: "compaction",
    title: "Compaction update intro",
    description: "User prompt intro when merging into a previous summary; supports ${previousSummary}",
  },
  {
    id: "runtime.structured_output_system",
    group: "runtime",
    title: "Structured output system",
    description: "System reminder when the user requested structured JSON output",
  },
  {
    id: "runtime.structured_output_tool",
    group: "runtime",
    title: "Structured output tool",
    description: "Description of the StructuredOutput tool",
  },
  {
    id: "runtime.max_steps",
    group: "runtime",
    title: "Max steps reached",
    description: "Message injected when an agent hits its step limit",
  },
]

function isPromptGroup(value: string): value is PromptGroup {
  return GROUPS.includes(value as PromptGroup)
}

function configPrompts(config: { prompts?: Record<string, string> } | undefined) {
  const prompts = config?.prompts
  if (!prompts || typeof prompts !== "object") return {} as Record<string, string>
  return prompts
}

async function loadCatalog(sdk: ReturnType<ReturnType<typeof useServerSDK>>): Promise<PromptCatalogItem[] | undefined> {
  try {
    const result = await sdk.client.config.prompts()
    if (result.error || !Array.isArray(result.data)) return undefined
    return result.data
      .map((row) => {
        if (!row || typeof row !== "object") return undefined
        const item = row as Record<string, unknown>
        if (typeof item.id !== "string") return undefined
        if (typeof item.group !== "string" || !isPromptGroup(item.group)) return undefined
        if (typeof item.title !== "string") return undefined
        if (typeof item.description !== "string") return undefined
        return {
          id: item.id,
          group: item.group,
          title: item.title,
          description: item.description,
          default: typeof item.default === "string" ? item.default : undefined,
          value: typeof item.value === "string" ? item.value : undefined,
          overridden: typeof item.overridden === "boolean" ? item.overridden : undefined,
        } satisfies PromptCatalogItem
      })
      .filter((item): item is PromptCatalogItem => !!item)
  } catch {
    return undefined
  }
}

export const SettingsPrompts: Component = () => {
  return (
    <SettingsServerScope>
      <SettingsPromptsContent />
    </SettingsServerScope>
  )
}

const SettingsPromptsContent: Component = () => {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const [selectedID, setSelectedID] = createSignal<string>()
  const [draft, setDraft] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  const [remoteCatalog] = createResource(
    () => serverSDK(),
    (sdk) => loadCatalog(sdk),
  )

  const overrides = createMemo(() => configPrompts(serverSync().data.config as { prompts?: Record<string, string> }))

  // Prefer server catalog (includes default bodies). Fall back to local metadata only after load fails.
  const catalogReady = createMemo(() => !remoteCatalog.loading)
  const sourceCatalog = createMemo(() => {
    const remote = remoteCatalog()
    if (remote && remote.length > 0) return remote
    if (remoteCatalog.loading) return [] as PromptCatalogItem[]
    return LOCAL_CATALOG
  })

  const items = createMemo(() => {
    const current = overrides()
    return sourceCatalog().map((item) => {
      const override = current[item.id]
      const hasLocal = Object.prototype.hasOwnProperty.call(current, item.id)
      const overridden = hasLocal ? override !== "" : (item.overridden ?? false)
      const body = overridden
        ? (override as string)
        : (item.default ?? item.value ?? "")
      return {
        ...item,
        overridden,
        default: item.default ?? item.value,
        value: body,
      }
    })
  })

  const list = useFilteredList<PromptCatalogItem>({
    items: () => items(),
    key: (item) => item.id,
    filterKeys: ["title", "id", "description", "group"],
    groupBy: (item) => item.group,
    sortGroupsBy: (a, b) => GROUPS.indexOf(a.category as PromptGroup) - GROUPS.indexOf(b.category as PromptGroup),
  })

  const selected = createMemo(() => {
    const id = selectedID()
    if (!id) return undefined
    return items().find((item) => item.id === id)
  })

  const baselineText = (item: PromptCatalogItem) => {
    const override = overrides()[item.id]
    if (override !== undefined && override !== "") return override
    return item.default ?? item.value ?? ""
  }

  const loadDraft = (id: string) => {
    const item = items().find((row) => row.id === id)
    if (!item) return
    setDraft(baselineText(item))
  }

  const dirty = createMemo(() => {
    const item = selected()
    if (!item) return false
    return draft() !== baselineText(item)
  })

  const isOverridden = createMemo(() => {
    const item = selected()
    if (!item) return false
    return item.overridden === true
  })

  // Reload editor when selection changes, or once catalog bodies arrive for the current selection.
  createEffect(
    on(selectedID, (id) => {
      if (!id) return
      if (sourceCatalog().length === 0) return
      loadDraft(id)
    }),
  )

  createEffect(
    on(
      () => sourceCatalog().length,
      (length, prev) => {
        if (length === 0) return
        if (prev !== undefined && prev > 0) return
        const id = selectedID()
        if (!id) return
        if (dirty()) return
        loadDraft(id)
      },
    ),
  )

  createEffect(() => {
    if (selectedID()) return
    const first = list.flat()[0]
    if (first) setSelectedID(first.id)
  })

  const save = async () => {
    const item = selected()
    if (!item || busy()) return
    setBusy(true)
    const before = { ...overrides() }
    const next = { ...before }
    const text = draft()
    // Empty string clears the override (mergeDeep cannot delete keys).
    next[item.id] = text

    serverSync().set("config", "prompts" as never, next as never)
    try {
      await serverSync().updateConfig({ prompts: next } as never)
      loadDraft(item.id)
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("settings.prompts.toast.saved.title"),
        description: language.t("settings.prompts.toast.saved.description", { title: item.title }),
      })
    } catch (err) {
      serverSync().set("config", "prompts" as never, before as never)
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBusy(false)
    }
  }

  const reset = async () => {
    const item = selected()
    if (!item || busy()) return
    setBusy(true)
    const before = { ...overrides() }
    const next = { ...before, [item.id]: "" }
    serverSync().set("config", "prompts" as never, next as never)
    try {
      await serverSync().updateConfig({ prompts: next } as never)
      loadDraft(item.id)
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("settings.prompts.toast.reset.title"),
        description: language.t("settings.prompts.toast.reset.description", { title: item.title }),
      })
    } catch (err) {
      serverSync().set("config", "prompts" as never, before as never)
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBusy(false)
    }
  }

  const groupLabel = (group: string) => {
    if (!isPromptGroup(group)) return group
    return language.t(GROUP_KEY[group] as never)
  }

  return (
    <div class="flex flex-col h-full overflow-hidden">
      <div class="flex flex-col gap-4 px-4 pt-6 pb-4 sm:px-10 shrink-0">
        <div class="flex items-center justify-between gap-4 max-w-[960px]">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.tab.prompts")}</h2>
          <SettingsServerPicker />
        </div>
        <div class="flex items-center gap-2 px-3 h-9 rounded-lg bg-surface-base max-w-[960px]">
          <Icon name="magnifying-glass" class="text-icon-weak-base flex-shrink-0" />
          <TextField
            variant="ghost"
            type="text"
            value={list.filter()}
            onChange={list.onInput}
            placeholder={language.t("settings.prompts.search.placeholder")}
            spellcheck={false}
            autocorrect="off"
            autocomplete="off"
            autocapitalize="off"
            class="flex-1"
          />
          <Show when={list.filter()}>
            <IconButton icon="circle-x" variant="ghost" onClick={list.clear} />
          </Show>
        </div>
      </div>

      <div class="flex flex-1 min-h-0 gap-4 px-4 pb-6 sm:px-10 max-w-[960px] w-full overflow-hidden">
        <div class="w-[240px] shrink-0 flex flex-col min-h-0 overflow-y-auto no-scrollbar">
          <Show
            when={catalogReady() && list.flat().length > 0}
            fallback={
              <div class="flex flex-col items-center justify-center py-12 text-center px-2">
                <span class="text-14-regular text-text-weak">
                  {remoteCatalog.loading
                    ? language.t("settings.prompts.editor.loading")
                    : language.t("settings.prompts.search.empty")}
                </span>
                <Show when={!remoteCatalog.loading && list.filter()}>
                  <span class="text-14-regular text-text-strong mt-1">&quot;{list.filter()}&quot;</span>
                </Show>
              </div>
            }
          >
            <For each={list.grouped.latest}>
              {(group) => (
                <div class="flex flex-col gap-1 mb-6 last:mb-0">
                  <h3 class="text-12-medium text-text-weak uppercase tracking-wide pb-1.5 px-1">
                    {groupLabel(group.category)}
                  </h3>
                  <SettingsList>
                    <For each={group.items}>
                      {(item) => {
                        const active = () => selectedID() === item.id
                        return (
                          <button
                            type="button"
                            classList={{
                              "w-full text-left flex items-center justify-between gap-2 py-2.5 px-1 border-b border-border-weak-base last:border-none transition-colors":
                                true,
                              "text-text-strong": active(),
                              "text-text-weak hover:text-text-strong": !active(),
                            }}
                            onClick={() => setSelectedID(item.id)}
                          >
                            <span class="text-13-regular truncate min-w-0">{item.title}</span>
                            <Show when={item.overridden}>
                              <Tag class="shrink-0">{language.t("settings.prompts.badge.overridden")}</Tag>
                            </Show>
                          </button>
                        )
                      }}
                    </For>
                  </SettingsList>
                </div>
              )}
            </For>
          </Show>
        </div>

        <div class="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
          <Show
            when={selected()}
            fallback={
              <div class="flex flex-col items-center justify-center h-full text-center">
                <span class="text-14-regular text-text-weak">
                  {remoteCatalog.loading
                    ? language.t("settings.prompts.editor.loading")
                    : language.t("settings.prompts.select")}
                </span>
              </div>
            }
          >
            {(item) => (
              <div class="flex flex-col h-full min-h-0 gap-3 overflow-hidden">
                <div class="flex flex-col gap-1 shrink-0">
                  <div class="flex items-center gap-2 flex-wrap">
                    <h3 class="text-14-medium text-text-strong">{item().title}</h3>
                    <Show when={isOverridden()}>
                      <Tag>{language.t("settings.prompts.badge.overridden")}</Tag>
                    </Show>
                  </div>
                  <span class="text-12-regular text-text-weak font-mono">{item().id}</span>
                  <span class="text-13-regular text-text-weak">{item().description}</span>
                </div>

                <div class="flex-1 min-h-0 min-w-0 overflow-hidden rounded-md border border-border-weak-base bg-surface-base">
                  <Show
                    when={catalogReady() && (draft() !== "" || isOverridden() || !remoteCatalog.loading)}
                    fallback={
                      <div class="h-full min-h-[200px] flex items-center justify-center">
                        <span class="text-13-regular text-text-weak">
                          {language.t("settings.prompts.editor.loading")}
                        </span>
                      </div>
                    }
                  >
                    <textarea
                      value={draft()}
                      onInput={(event) => setDraft(event.currentTarget.value)}
                      spellcheck={false}
                      autocomplete="off"
                      autocapitalize="off"
                      class="block w-full h-full min-h-0 p-3 font-mono text-12-regular text-text-strong bg-transparent border-0 outline-none resize-none overflow-y-auto no-scrollbar"
                      aria-label={language.t("settings.prompts.editor.label")}
                    />
                  </Show>
                </div>

                <div class="flex items-center justify-end gap-2 shrink-0 pt-1">
                  <Button size="small" variant="ghost" onClick={() => void reset()} disabled={busy() || !isOverridden()}>
                    {language.t("settings.prompts.action.reset")}
                  </Button>
                  <Button size="small" variant="primary" onClick={() => void save()} disabled={busy() || !dirty()}>
                    {busy() ? language.t("settings.prompts.action.saving") : language.t("settings.prompts.action.save")}
                  </Button>
                </div>
              </div>
            )}
          </Show>
        </div>
      </div>
    </div>
  )
}
