import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { createMemo, createResource, For, Show } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useTerminal } from "@/context/terminal"
import { useSessionLayout } from "@/pages/session/session-layout"
import { focusTerminalById } from "@/pages/session/helpers"
import { DialogRunScripts } from "./dialog-run-scripts"

type RunCommand = {
  name: string
  template: string
  source?: string
}

export function SessionRunScripts() {
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useSDK()
  const terminal = useTerminal()
  const { params, view } = useSessionLayout()
  const directory = createMemo(() => params.dir ?? "")
  const [commands, commandsControl] = createResource(directory, async (value): Promise<RunCommand[]> => {
    if (!value) return []
    // throwOnError 客户端在请求失败（含 run.json 解析失败返回 422）时直接抛错，
    // 失败必须冒泡为 resource.error，绝不能静默降级成空列表。
    const result = await sdk().client.command.getRun({ directory: sdk().directory })
    // getRun 成功时返回 Location.response(RunFile) 的 { location, data } 信封。
    if (!result.data) throw new Error("Run script file is unavailable")
    return Object.entries(result.data.data.scripts).map(([name, template]) => ({
      name,
      template,
      source: "run",
    }))
  })
  const scripts = createMemo(() => commands()?.filter((command) => command.source === "run") ?? [])

  const run = (script: RunCommand) => {
    void terminal.new({ initialInput: script.template, title: script.name, focus: true }).then((id) => {
      if (!id) return
      view().terminal.open()
      terminal.open(id)
      focusTerminalById(id)
    })
  }

  const edit = () => {
    dialog.show(() => (
      <DialogRunScripts
        scripts={scripts()}
        onSaved={() => {
          void commandsControl.refetch()
        }}
      />
    ))
  }

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        as={IconButton}
        icon="console"
        variant="ghost"
        class="size-6 rounded-md data-[expanded]:bg-surface-base-active"
        aria-label={language.t("session.header.run")}
        onClick={() => void commandsControl.refetch()}
      />
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="mt-1 min-w-44">
          <DropdownMenu.Group>
            <DropdownMenu.GroupLabel>{language.t("session.header.run")}</DropdownMenu.GroupLabel>
            <Show
              when={!commands.error}
              fallback={
                <div class="max-w-64 px-2 py-1.5 text-12-regular text-icon-critical-base">
                  {commands.error instanceof Error ? commands.error.message : String(commands.error)}
                </div>
              }
            >
              <For each={scripts()}>
                {(script) => (
                  <DropdownMenu.Item onSelect={() => run(script)}>
                    <Icon name="console" size="small" class="text-icon-weak" />
                    <DropdownMenu.ItemLabel>{script.name}</DropdownMenu.ItemLabel>
                  </DropdownMenu.Item>
                )}
              </For>
            </Show>
          </DropdownMenu.Group>
          <DropdownMenu.Separator />
          <DropdownMenu.Item onSelect={edit}>
            <Icon name="edit" size="small" class="text-icon-weak" />
            <DropdownMenu.ItemLabel>{language.t("common.edit")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}
