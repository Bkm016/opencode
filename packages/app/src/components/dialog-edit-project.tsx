import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { Icon } from "@opencode-ai/ui/icon"
import { Show } from "solid-js"
import { type LocalProject } from "@/context/layout"
import { Avatar } from "@opencode-ai/ui/avatar"
import { useLanguage } from "@/context/language"
import { getProjectAvatarSource } from "@/pages/layout/helpers"
import { ServerConnection } from "@/context/server"
import { createEditProjectModel } from "./edit-project"

export function DialogEditProject(props: { project: LocalProject; server: ServerConnection.Any }) {
  const language = useLanguage()
  const model = createEditProjectModel(props)

  return (
    <Dialog title={language.t("dialog.project.edit.title")} class="w-full max-w-[480px] mx-auto">
      <form onSubmit={model.submit} class="flex flex-col gap-6 p-6 pt-0">
        <div class="flex flex-col gap-4">
          <TextField
            autofocus
            type="text"
            label={language.t("dialog.project.edit.name")}
            placeholder={model.folderName()}
            value={model.store.name}
            onChange={(v) => model.setStore("name", v)}
          />

          <div class="flex flex-col gap-2">
            <label class="text-12-medium text-text-weak">{language.t("dialog.project.edit.icon")}</label>
            <div class="flex gap-3 items-start">
              <div
                class="relative"
                onMouseEnter={() => model.setStore("iconHover", true)}
                onMouseLeave={() => model.setStore("iconHover", false)}
              >
                <div
                  class="relative size-16 rounded-md transition-colors cursor-pointer"
                  classList={{
                    "border-text-interactive-base bg-surface-info-base/20": model.store.dragOver,
                    "border-border-base hover:border-border-strong": !model.store.dragOver,
                    "overflow-hidden": !!model.store.iconOverride,
                  }}
                  onDrop={model.drop}
                  onDragOver={model.dragOver}
                  onDragLeave={model.dragLeave}
                  onClick={model.iconClick}
                >
                  <Show
                    when={getProjectAvatarSource(props.project.id, {
                      color: model.store.color,
                      url: props.project.icon?.url,
                      override: model.store.iconOverride,
                    })}
                    fallback={
                      <div class="size-full flex items-center justify-center">
                        <Avatar
                          fallback={model.store.name || model.defaultName()}
                          class="size-full text-[32px]"
                        />
                      </div>
                    }
                  >
                    {(src) => (
                      <img
                        src={src()}
                        alt={language.t("dialog.project.edit.icon.alt")}
                        class="size-full object-cover"
                      />
                    )}
                  </Show>
                </div>
                <div
                  class="absolute inset-0 size-16 bg-surface-raised-stronger-non-alpha/90 rounded-[6px] z-10 pointer-events-none flex items-center justify-center transition-opacity"
                  classList={{
                    "opacity-100": model.store.iconHover && !model.store.iconOverride,
                    "opacity-0": !(model.store.iconHover && !model.store.iconOverride),
                  }}
                >
                  <Icon name="cloud-upload" size="large" class="text-icon-on-interactive-base drop-shadow-sm" />
                </div>
                <div
                  class="absolute inset-0 size-16 bg-surface-raised-stronger-non-alpha/90 rounded-[6px] z-10 pointer-events-none flex items-center justify-center transition-opacity"
                  classList={{
                    "opacity-100": model.store.iconHover && !!model.store.iconOverride,
                    "opacity-0": !(model.store.iconHover && !!model.store.iconOverride),
                  }}
                >
                  <Icon name="trash" size="large" class="text-icon-on-interactive-base drop-shadow-sm" />
                </div>
              </div>
              <input
                id="icon-upload"
                ref={(el) => {
                  model.setIconInput(el)
                }}
                type="file"
                accept="image/*"
                class="hidden"
                onChange={model.inputChange}
              />
              <div class="flex flex-col gap-1.5 text-12-regular text-text-weak self-center">
                <span>{language.t("dialog.project.edit.icon.hint")}</span>
                <span>{language.t("dialog.project.edit.icon.recommended")}</span>
              </div>
            </div>
          </div>

          <TextField
            multiline
            label={language.t("dialog.project.edit.worktree.startup")}
            description={language.t("dialog.project.edit.worktree.startup.description")}
            placeholder={language.t("dialog.project.edit.worktree.startup.placeholder")}
            value={model.store.startup}
            onChange={(v) => model.setStore("startup", v)}
            spellcheck={false}
            class="max-h-14 w-full overflow-y-auto font-mono text-xs"
          />
        </div>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="large" onClick={model.close}>
            {language.t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" size="large" disabled={model.save.isPending}>
            {model.save.isPending ? language.t("common.saving") : language.t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
