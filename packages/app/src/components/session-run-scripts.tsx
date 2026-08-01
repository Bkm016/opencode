import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { createMemo, createResource, For } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useTerminal } from "@/context/terminal"
import { useSessionLayout } from "@/pages/session/session-layout"
import { focusTerminalById } from "@/pages/session/helpers"
import { retry } from "@opencode-ai/core/util/retry"
import { DialogRunScripts } from "./dialog-run-scripts"

type RunCommand = {
  name: string
  template: string
  source?: string
}

function runFileData(value: unknown): { scripts: Record<string, string> } | undefined {
  if (typeof value !== "object" || value === null) return
  if (
    "scripts" in value &&
    typeof value.scripts === "object" &&
    value.scripts !== null &&
    !Array.isArray(value.scripts)
  ) {
    return { scripts: value.scripts as Record<string, string> }
  }
  if ("data" in value) return runFileData(value.data)
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

    try {
      return await retry(
        async () => {
          const result = await sdk().client.command.getRun({ directory: sdk().directory })
          const file = runFileData(result)
          if (!file) throw new Error("Run script file is not ready")
          const parsed = Object.entries(file.scripts).map(([name, template]) => ({ name, template, source: "run" }))
          console.info(`[run] list response scripts: ${parsed.map((command) => command.name).join(", ")}`)
          return parsed
        },
        { attempts: 6, delay: 500, retryIf: () => true },
      )
    } catch {
      return []
    }
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
            <For each={scripts()}>
              {(script) => (
                <DropdownMenu.Item onSelect={() => run(script)}>
                  <Icon name="console" size="small" class="text-icon-weak" />
                  <DropdownMenu.ItemLabel>{script.name}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
              )}
            </For>
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
