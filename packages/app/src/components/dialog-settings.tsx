import { Component, Show, createSignal, startTransition } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tabs } from "@opencode-ai/ui/tabs"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { SettingsGeneral } from "./settings-general"
import { SettingsKeybinds } from "./settings-keybinds"
import { SettingsAgents } from "./settings-agents"
import { SettingsModels } from "./settings-models"
import { SettingsPermissions } from "./settings-permissions"
import { SettingsServers } from "./settings-servers"
import { SettingsDatabase } from "./settings-database"
import { SettingsInstructions } from "./settings-instructions"
import { SettingsPrompts } from "./settings-prompts"
import { SettingsMcp } from "./settings-mcp"
import { SettingsDeploy } from "./settings-deploy"

export const DialogSettings: Component<{ defaultValue?: string }> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()
  const initialTab = props.defaultValue === "providers" ? "models" : (props.defaultValue ?? "general")
  const [tab, setTab] = createSignal(initialTab)
  const dialog = useDialog()
  // 手机上改为两级导航：先是分区列表，点进某一项再全屏展示该页，顶部栏负责返回与关闭。
  const compact = createMediaQuery("(max-width: 767px)")
  const [view, setView] = createSignal<"list" | "detail">(props.defaultValue ? "detail" : "list")

  return (
    <Dialog size="x-large" transition>
      <Show when={compact()}>
        <div
          data-slot="settings-mobile-bar"
          class="flex h-12 w-full shrink-0 items-center gap-1 border-b border-border-weak-base px-2"
        >
          <Show
            when={view() === "detail"}
            fallback={<span class="pl-2 text-16-medium text-text-strong">{language.t("sidebar.settings")}</span>}
          >
            <button
              type="button"
              class="flex h-9 items-center gap-0.5 rounded-md pl-1 pr-2 text-14-medium text-text-strong active:bg-surface-base-hover"
              aria-label={language.t("common.goBack")}
              onClick={() => setView("list")}
            >
              <Icon name="chevron-left" />
              {language.t("sidebar.settings")}
            </button>
          </Show>
          <div class="flex-1" />
          <IconButton
            icon="close"
            variant="ghost"
            class="size-9"
            aria-label={language.t("common.close")}
            onClick={() => dialog.close()}
          />
        </div>
      </Show>
      <Tabs
        orientation="vertical"
        variant="settings"
        value={tab()}
        onChange={(value) => void startTransition(() => setTab(value))}
        class="h-full min-h-0 settings-dialog"
        data-mobile-view={compact() ? view() : undefined}
      >
        <Tabs.List>
          <div
            class="flex flex-col justify-between h-full w-full gap-4"
            onClick={(event) => {
              if (compact() && (event.target as HTMLElement).closest("[data-slot='tabs-trigger']")) setView("detail")
            }}
          >
            <div class="flex flex-col gap-3 w-full pt-3">
              <div class="flex flex-col gap-3">
                <div class="flex flex-col gap-1.5">
                  <Tabs.SectionTitle>{language.t("settings.section.desktop")}</Tabs.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <Tabs.Trigger value="general">
                      <Icon name="sliders" />
                      {language.t("settings.tab.general")}
                    </Tabs.Trigger>
                    {/* 手机没有键盘，快捷键设置在这里没有意义。 */}
                    <Show when={!compact()}>
                      <Tabs.Trigger value="shortcuts">
                        <Icon name="keyboard" />
                        {language.t("settings.tab.shortcuts")}
                      </Tabs.Trigger>
                    </Show>
                    <Tabs.Trigger value="servers">
                      <Icon name="server" />
                      {language.t("status.popover.tab.servers")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="database">
                      <Icon name="console" />
                      {language.t("settings.tab.database")}
                    </Tabs.Trigger>
                  </div>
                </div>

                <div class="flex flex-col gap-1.5">
                  <Tabs.SectionTitle>{language.t("settings.section.server")}</Tabs.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <Tabs.Trigger value="agents">
                      <Icon name="brain" />
                      {language.t("settings.agents.title")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="models">
                      <Icon name="models" />
                      {language.t("settings.models.title")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="permissions">
                      <Icon name="shield" />
                      {language.t("settings.permissions.title")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="prompts">
                      <Icon name="prompt" />
                      {language.t("settings.tab.prompts")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="instructions">
                      <Icon name="sliders" />
                      {language.t("settings.tab.instructions")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="mcp">
                      <Icon name="mcp" />
                      {language.t("settings.mcp.title")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="deploy">
                      <Icon name="branch" />
                      {language.t("settings.deploy.title")}
                    </Tabs.Trigger>
                  </div>
                </div>
              </div>
            </div>
            <div class="flex flex-col gap-1 pl-1 py-1 text-12-medium text-text-weak">
              <span>{language.t("app.name.desktop")}</span>
              <span class="text-11-regular">v{platform.version}</span>
            </div>
          </div>
        </Tabs.List>
        <Tabs.Content value="general" class="no-scrollbar">
          <SettingsGeneral />
        </Tabs.Content>
        <Tabs.Content value="shortcuts" class="no-scrollbar">
          <SettingsKeybinds />
        </Tabs.Content>
        <Tabs.Content value="servers" class="no-scrollbar">
          <SettingsServers />
        </Tabs.Content>
        <Tabs.Content value="database" class="no-scrollbar">
          <SettingsDatabase />
        </Tabs.Content>
        <Tabs.Content value="agents" class="no-scrollbar">
          <SettingsAgents />
        </Tabs.Content>
        <Tabs.Content value="models" class="no-scrollbar">
          <SettingsModels />
        </Tabs.Content>
        <Tabs.Content value="permissions" class="no-scrollbar">
          <SettingsPermissions />
        </Tabs.Content>
        <Tabs.Content value="prompts" class="no-scrollbar">
          <SettingsPrompts />
        </Tabs.Content>
        <Tabs.Content value="instructions" class="no-scrollbar">
          <SettingsInstructions />
        </Tabs.Content>
        <Tabs.Content value="mcp" class="no-scrollbar">
          <SettingsMcp />
        </Tabs.Content>
        <Tabs.Content value="deploy" class="no-scrollbar">
          <SettingsDeploy />
        </Tabs.Content>
      </Tabs>
    </Dialog>
  )
}
