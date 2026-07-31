import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { createSignal, For } from "solid-js"
import { createStore } from "solid-js/store"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useSDK } from "@/context/sdk"
import { showToast } from "@/utils/toast"

type RunScript = {
  name: string
  template: string
}

type DraftScript = {
  name: string
  template: string
}

function runFilePath(value: unknown) {
  if (typeof value !== "object" || value === null) return
  if ("path" in value && typeof value.path === "string") return value.path
  if (!("data" in value) || typeof value.data !== "object" || value.data === null) return
  if ("path" in value.data && typeof value.data.path === "string") return value.data.path
  if (
    !("data" in value.data) ||
    typeof value.data.data !== "object" ||
    value.data.data === null ||
    !("path" in value.data.data) ||
    typeof value.data.data.path !== "string"
  )
    return
  return value.data.data.path
}

export function DialogRunScripts(props: { scripts: RunScript[]; onSaved: () => void }) {
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()
  const server = useServer()
  const sdk = useSDK()
  const [store, setStore] = createStore<{ scripts: DraftScript[] }>({
    scripts: props.scripts.map((script) => ({ ...script })),
  })
  const [error, setError] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const canOpenFile = () => platform.platform === "desktop" && !!platform.openPath && server.isLocal()

  const openFile = async () => {
    if (!canOpenFile() || !platform.openPath) return
    try {
      const result = await sdk().client.v2.command.getRun({ location: { directory: sdk().directory } })
      const runPath = runFilePath(result)
      if (!runPath) throw new Error("The current run script file is unavailable.")
      await platform.openPath(runPath)
    } catch (cause) {
      showToast({
        variant: "error",
        title: language.t("dialog.run.openFile"),
        description: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (saving()) return
    setError("")

    try {
      const scripts = Object.fromEntries(
        store.scripts.map((script) => {
          const name = script.name.trim()
          const template = script.template.trim()
          if (!name || !template) throw new Error("invalid")
          return [name, template]
        }),
      )
      if (Object.keys(scripts).length !== store.scripts.length) throw new Error("invalid")

      setSaving(true)
      const directory = sdk().directory
      console.info(`[run] save request directory: ${directory}`)
      const result = await sdk().client.v2.command.updateRun(
        {
          location: { directory },
          commandV2RunConfig: { scripts },
        },
        { throwOnError: true },
      )
      console.info("[run] save response:", JSON.stringify(result))
      console.info(`[run] save response path: ${runFilePath(result) ?? "unknown"}`)
      dialog.close()
      props.onSaved()
    } catch (cause) {
      if (cause instanceof Error && cause.message === "invalid") {
        console.warn("[run] save request not sent: every script needs a unique name and command")
        setError(language.t("dialog.run.invalid"))
      } else if (cause instanceof Error && cause.message) {
        console.error("Failed to save project run scripts", cause)
        setError(cause.message)
      } else if (typeof cause === "string" && cause) {
        console.error("Failed to save project run scripts", cause)
        setError(cause)
      } else {
        console.error("Failed to save project run scripts", cause)
        setError(language.t("dialog.run.saveFailed"))
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      title={language.t("dialog.run.title")}
      class="w-full max-w-[560px] max-h-[calc(100vh-32px)] mx-auto overflow-hidden"
    >
      <form onSubmit={submit} class="flex min-h-0 max-h-[calc(100vh-112px)] flex-col gap-5 p-6 pt-0">
        <p class="text-12-regular text-text-weak">{language.t("dialog.run.description")}</p>
        <div class="no-scrollbar min-h-0 flex-1 overflow-y-auto pr-1">
          <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_2rem] items-center gap-2 pb-2 text-11-medium text-text-weak">
            <div>{language.t("dialog.run.name")}</div>
            <div>{language.t("dialog.run.command")}</div>
            <div />
          </div>
          <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_2rem] items-end gap-2">
          <For each={store.scripts}>
            {(script, index) => (
              <>
                <TextField
                  placeholder={language.t("dialog.run.namePlaceholder")}
                  value={script.name}
                  onChange={(value) => setStore("scripts", index(), "name", value)}
                  class="min-w-0"
                />
                <TextField
                  placeholder={language.t("dialog.run.commandPlaceholder")}
                  value={script.template}
                  onChange={(value) => setStore("scripts", index(), "template", value)}
                  spellcheck={false}
                  class="min-w-0 font-mono text-12-regular"
                />
                <Button
                  type="button"
                  variant="ghost"
                  icon="trash"
                  class="size-8"
                  aria-label={language.t("dialog.run.remove")}
                  onClick={() => setStore("scripts", (scripts) => scripts.filter((_, i) => i !== index()))}
                />
              </>
            )}
          </For>
          </div>
        </div>
        {error() && <div class="text-12-regular text-icon-critical-base whitespace-pre-wrap">{error()}</div>}
        <div class="flex shrink-0 items-center justify-between gap-3">
          <div class="flex min-w-0 gap-2">
            <Button
              type="button"
              variant="ghost"
              size="large"
              icon="plus-small"
              onClick={() => setStore("scripts", (scripts) => [...scripts, { name: "", template: "" }])}
            >
              {language.t("dialog.run.add")}
            </Button>
            <Button type="button" variant="ghost" size="large" disabled={!canOpenFile()} onClick={openFile}>
              {language.t("dialog.run.openFile")}
            </Button>
          </div>
          <div class="flex shrink-0 gap-2">
            <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" size="large" disabled={saving()}>
              {saving() ? language.t("common.saving") : language.t("common.save")}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  )
}
