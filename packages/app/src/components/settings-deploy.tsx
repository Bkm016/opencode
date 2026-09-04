import { Button } from "@opencode-ai/ui/button"
import { type Component, Show, createResource, createSignal } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { SettingsList } from "./settings-list"
import { SettingsServerPicker, SettingsServerScope } from "./settings-server-picker"

export const SettingsDeploy: Component = () => {
  return (
    <SettingsServerScope>
      <SettingsDeployContent />
    </SettingsServerScope>
  )
}

const SettingsDeployContent: Component = () => {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const [copied, setCopied] = createSignal(false)
  const [deployKey, { refetch }] = createResource(
    () => serverSDK().client,
    async (client) => {
      const result = await client.v2.deployKey.get()
      if (result.error || !result.data) throw new Error(language.t("settings.deploy.unavailable"))
      return result.data
    },
  )

  const copy = () => {
    const publicKey = deployKey.latest?.publicKey
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
    if (!publicKey || !clipboard?.writeText) {
      showToast({ variant: "error", title: language.t("settings.deploy.toast.copyFailed.title") })
      return
    }
    void clipboard.writeText(publicKey).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      },
      () => showToast({ variant: "error", title: language.t("settings.deploy.toast.copyFailed.title") }),
    )
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-4 pt-6 pb-6 max-w-[720px]">
          <div class="flex items-start justify-between gap-4">
            <div class="flex min-w-0 flex-col gap-1">
              <h2 class="text-16-medium text-text-strong">{language.t("settings.deploy.title")}</h2>
              <p class="text-12-regular text-text-weak">{language.t("settings.deploy.description")}</p>
            </div>
            <SettingsServerPicker />
          </div>
        </div>
      </div>

      <div class="flex flex-col gap-8 w-full max-w-[720px]">
        <Show
          when={!deployKey.loading || deployKey.latest}
          fallback={
            <div class="flex items-center justify-center py-12 text-14-regular text-text-weak">
              {language.t("settings.deploy.loading")}
            </div>
          }
        >
          <Show
            when={deployKey.latest}
            fallback={
              <div class="flex flex-col items-center justify-center gap-3 py-12 text-center">
                <span class="text-14-regular text-text-weak">{language.t("settings.deploy.unavailable")}</span>
                <Button size="small" variant="ghost" onClick={() => void refetch()}>
                  {language.t("settings.deploy.retry")}
                </Button>
              </div>
            }
          >
            {(key) => (
              <div class="flex flex-col gap-1">
                <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.deploy.publicKey.title")}</h3>
                <p class="text-12-regular text-text-weak pb-2">{language.t("settings.deploy.publicKey.description")}</p>
                <SettingsList>
                  <div class="flex flex-col gap-4 py-4">
                    <div class="flex flex-wrap items-center justify-between gap-3">
                      <span class="text-12-medium text-text-strong">{key().algorithm}</span>
                      <Button size="small" variant="secondary" icon={copied() ? "check" : "copy"} onClick={copy}>
                        {copied() ? language.t("settings.deploy.copied") : language.t("settings.deploy.copy")}
                      </Button>
                    </div>
                    <code
                      class="block rounded-md bg-surface-weak-base px-3 py-3 font-mono text-12-regular text-text-strong break-all select-text"
                      data-component="deploy-public-key"
                    >
                      {key().publicKey}
                    </code>
                    <dl class="flex flex-col gap-3 pt-1">
                      <div class="flex flex-col gap-1">
                        <dt class="text-12-medium text-text-strong">{language.t("settings.deploy.privateKeyPath")}</dt>
                        <dd class="font-mono text-11-regular text-text-weak break-all select-text">
                          {key().privateKeyPath}
                        </dd>
                      </div>
                      <div class="flex flex-col gap-1">
                        <dt class="text-12-medium text-text-strong">{language.t("settings.deploy.publicKeyPath")}</dt>
                        <dd class="font-mono text-11-regular text-text-weak break-all select-text">
                          {key().publicKeyPath}
                        </dd>
                      </div>
                    </dl>
                  </div>
                </SettingsList>
              </div>
            )}
          </Show>
        </Show>
      </div>
    </div>
  )
}
