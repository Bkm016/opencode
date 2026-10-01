import { createEffect, createMemo, on } from "solid-js"
import type { UpdaterState } from "@/updater"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"

export function updaterAction(state: UpdaterState | undefined) {
  if (!state) return { label: "settings.updates.action.checkNow" as const }
  switch (state.status) {
    case "checking":
      return { label: "settings.updates.action.checking" as const }
    case "downloading":
      return { label: "settings.updates.action.downloading" as const }
    case "ready":
      return { label: "toast.update.action.installRestart" as const, run: "install" as const }
    case "installing":
      return { label: "settings.updates.action.installing" as const }
    case "disabled":
      return { label: "settings.updates.action.checkNow" as const }
    default:
      return { label: "settings.updates.action.checkNow" as const, run: "check" as const }
  }
}

export function useUpdaterAction() {
  const platform = usePlatform()
  const language = useLanguage()
  const action = createMemo(() => updaterAction(platform.updater?.state()))

  return {
    action,
    async run() {
      const run = action().run
      if (run === "install") return platform.updater?.install()
      if (run !== "check") return

      const state = await platform.updater?.check()
      if (state?.status === "up-to-date") {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("settings.updates.toast.latest.title"),
          description: language.t("settings.updates.toast.latest.description", { version: platform.version ?? "" }),
        })
      }
      if (state?.status === "error") {
        showToast({ title: language.t("common.requestFailed"), description: state.message })
      }
    },
  }
}

/** 后台下载好新版本后弹一次常驻提示：立即安装并重启，或稍后（退出应用时也会自动安装）。 */
export function useUpdaterNotice() {
  const platform = usePlatform()
  const language = useLanguage()
  const ready = createMemo(() => {
    const state = platform.updater?.state()
    return state?.status === "ready" ? state.version : undefined
  })
  createEffect(
    on(ready, (version) => {
      if (!version) return
      showToast({
        persistent: true,
        icon: "arrow-down-to-line",
        title: language.t("toast.update.title"),
        description: language.t("toast.update.description", { version }),
        actions: [
          {
            label: language.t("toast.update.action.installRestart"),
            onClick: () => {
              void platform.updater?.install().catch((error: unknown) => {
                showToast({
                  title: language.t("common.requestFailed"),
                  description: error instanceof Error ? error.message : String(error),
                })
              })
            },
          },
          { label: language.t("toast.update.action.notYet"), onClick: "dismiss" },
        ],
      })
    }),
  )
}
