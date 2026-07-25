import { useNavigate } from "@solidjs/router"
import { useCommand, type CommandOption } from "@/context/command"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useLocal } from "@/context/local"
import { usePermission } from "@/context/permission"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useTerminal } from "@/context/terminal"
import { showToast } from "@/utils/toast"
import { findLast } from "@opencode-ai/core/util/array"
import { extractPromptFromParts } from "@/utils/prompt"
import { UserMessage } from "@opencode-ai/sdk/v2"
import { useSessionLayout } from "@/pages/session/session-layout"
import { createSessionOwnership } from "./session-ownership"

export type SessionCommandContext = {
  navigateMessageByOffset: (offset: number) => void
  setActiveMessage: (message: UserMessage | undefined) => void
  focusInput: () => void
  openFind?: () => void
}

const withCategory = (category: string) => {
  return (option: Omit<CommandOption, "category">): CommandOption => ({
    ...option,
    category,
  })
}

export const useSessionCommands = (actions: SessionCommandContext) => {
  const command = useCommand()
  const dialog = useDialog()
  const language = useLanguage()
  const local = useLocal()
  const permission = usePermission()
  const prompt = usePrompt()
  const sdk = useSDK()
  const sync = useSync()
  const terminal = useTerminal()
  const navigate = useNavigate()
  const { params, sessionKey, view } = useSessionLayout()
  const sessionOwnership = createSessionOwnership(sessionKey)
  const openDialog = async <T,>(load: () => Promise<T>, show: (value: T) => void) => {
    const owner = sessionOwnership.capture()
    const value = await load()
    owner.run(() => show(value))
  }
  const runCommand = async <T,>(input: {
    owner: ReturnType<ReturnType<typeof createSessionOwnership>["capture"]>
    prompt: T
    request: () => Promise<unknown>
    updatePrompt: (prompt: T) => void
    updateViewport: () => void
  }) => {
    await input.request()
    input.updatePrompt(input.prompt)
    input.owner.run(input.updateViewport)
  }

  const info = () => {
    const id = params.id
    if (!id) return
    return sync().session.get(id)
  }

  const messages = () => {
    const id = params.id
    if (!id) return []
    return sync().data.message[id] ?? []
  }
  const userMessages = () => messages().filter((m) => m.role === "user") as UserMessage[]
  const visibleUserMessages = () => {
    const revert = info()?.revert?.messageID
    if (!revert) return userMessages()
    return userMessages().filter((m) => m.id < revert)
  }

  const navigateMessageByOffset = actions.navigateMessageByOffset
  const setActiveMessage = actions.setActiveMessage
  const focusInput = actions.focusInput
  const openFind = actions.openFind

  const sessionCommand = withCategory(language.t("command.category.session"))
  const viewCommand = withCategory(language.t("command.category.view"))
  const terminalCommand = withCategory(language.t("command.category.terminal"))
  const mcpCommand = withCategory(language.t("command.category.mcp"))
  const permissionsCommand = withCategory(language.t("command.category.permissions"))

  const isAutoAcceptActive = () => {
    const sessionID = params.id
    if (sessionID) return permission.isAutoAccepting(sessionID, sdk().directory)
    return permission.isAutoAcceptingDirectory(sdk().directory)
  }
  const write = async (value: string) => {
    const body = typeof document === "undefined" ? undefined : document.body
    if (body) {
      const textarea = document.createElement("textarea")
      textarea.value = value
      textarea.setAttribute("readonly", "")
      textarea.style.position = "fixed"
      textarea.style.opacity = "0"
      textarea.style.pointerEvents = "none"
      body.appendChild(textarea)
      textarea.select()
      const copied = document.execCommand("copy")
      body.removeChild(textarea)
      if (copied) return true
    }

    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
    if (!clipboard?.writeText) return false
    return clipboard.writeText(value).then(
      () => true,
      () => false,
    )
  }

  const copyShare = async (url: string, existing: boolean) => {
    if (!(await write(url))) {
      showToast({
        title: language.t("toast.session.share.copyFailed.title"),
        variant: "error",
      })
      return
    }

    showToast({
      title: existing ? language.t("session.share.copy.copied") : language.t("toast.session.share.success.title"),
      description: language.t("toast.session.share.success.description"),
      variant: "success",
    })
  }

  const share = async () => {
    const sessionID = params.id
    if (!sessionID) return

    const existing = info()?.share?.url
    if (existing) {
      await copyShare(existing, true)
      return
    }

    const url = await sdk()
      .client.session.share({ sessionID })
      .then((res) => res.data?.share?.url)
      .catch(() => undefined)
    if (!url) {
      showToast({
        title: language.t("toast.session.share.failed.title"),
        description: language.t("toast.session.share.failed.description"),
        variant: "error",
      })
      return
    }

    await copyShare(url, false)
  }

  const unshare = async () => {
    const sessionID = params.id
    if (!sessionID) return

    await sdk()
      .client.session.unshare({ sessionID })
      .then(() =>
        showToast({
          title: language.t("toast.session.unshare.success.title"),
          description: language.t("toast.session.unshare.success.description"),
          variant: "success",
        }),
      )
      .catch(() =>
        showToast({
          title: language.t("toast.session.unshare.failed.title"),
          description: language.t("toast.session.unshare.failed.description"),
          variant: "error",
        }),
      )
  }

  const openTerminal = () => {
    if (terminal.all().length > 0) terminal.new({ focus: true })
    if (terminal.all().length === 0) terminal.requestFocus()
    view().terminal.open()
  }

  const closeTerminal = () => {
    const id = terminal.active()
    if (!id) return
    const last = terminal.all().length === 1
    void terminal.close(id)
    if (last) view().terminal.close()
  }

  const chooseMcp = () => {
    void openDialog(
      () => import("@/components/dialog-select-mcp"),
      (x) => dialog.show(() => <x.DialogSelectMcp />),
    )
  }

  const toggleAutoAccept = () => {
    const sessionID = params.id
    if (sessionID) permission.toggleAutoAccept(sessionID, sdk().directory)
    else permission.toggleAutoAcceptDirectory(sdk().directory)

    const active = sessionID
      ? permission.isAutoAccepting(sessionID, sdk().directory)
      : permission.isAutoAcceptingDirectory(sdk().directory)
    showToast({
      title: active
        ? language.t("toast.permissions.autoaccept.on.title")
        : language.t("toast.permissions.autoaccept.off.title"),
      description: active
        ? language.t("toast.permissions.autoaccept.on.description")
        : language.t("toast.permissions.autoaccept.off.description"),
    })
  }

  const undo = async () => {
    const sessionID = params.id
    if (!sessionID) return
    const owner = sessionOwnership.capture()
    const client = sdk().client
    const directory = sdk().directory
    const promptSession = prompt.capture()
    const revert = info()?.revert?.messageID
    const messages = userMessages()
    const message = findLast(messages, (x) => !revert || x.id < revert)
    if (!message) return
    const parts = sync().data.part[message.id]

    if (sync().data.session_working(sessionID)) {
      await client.session.abort({ sessionID }).catch(() => {})
    }

    await runCommand({
      owner,
      prompt: promptSession,
      request: () => client.session.revert({ sessionID, messageID: message.id }),
      updatePrompt: (promptSession) => {
        if (parts) promptSession.set(extractPromptFromParts(parts, { directory }))
      },
      updateViewport: () => setActiveMessage(findLast(messages, (x) => x.id < message.id)),
    })
  }

  const redo = async () => {
    const sessionID = params.id
    if (!sessionID) return
    const owner = sessionOwnership.capture()
    const client = sdk().client
    const messages = userMessages()
    const promptSession = prompt.capture()

    const revertMessageID = info()?.revert?.messageID
    if (!revertMessageID) return

    const next = messages.find((x) => x.id > revertMessageID)
    if (!next) {
      await runCommand({
        owner,
        prompt: promptSession,
        request: () => client.session.unrevert({ sessionID }),
        updatePrompt: (promptSession) => promptSession.reset(),
        updateViewport: () => setActiveMessage(findLast(messages, (x) => x.id >= revertMessageID)),
      })
      return
    }

    await runCommand({
      owner,
      prompt: promptSession,
      request: () => client.session.revert({ sessionID, messageID: next.id }),
      updatePrompt: () => undefined,
      updateViewport: () => setActiveMessage(findLast(messages, (x) => x.id < next.id)),
    })
  }

  const compact = async () => {
    const sessionID = params.id
    if (!sessionID) return

    const model = local.model.current()
    if (!model) {
      showToast({
        title: language.t("toast.model.none.title"),
        description: language.t("toast.model.none.description"),
      })
      return
    }

    await sdk().client.session.summarize({
      sessionID,
      modelID: model.id,
      providerID: model.provider.id,
    })
  }

  const fork = () => {
    void openDialog(
      () => import("@/components/dialog-fork"),
      (x) => dialog.show(() => <x.DialogFork />),
    )
  }

  const openChildSessions = () => {
    const sessionID = params.id
    if (!sessionID) return
    void openDialog(
      () => import("@/components/dialog-child-sessions"),
      (x) => dialog.show(() => <x.DialogChildSessions parentID={sessionID} />),
    )
  }

  const shareCmds = () => {
    if (sync().data.config.share === "disabled") return []
    return [
      sessionCommand({
        id: "session.share",
        title: info()?.share?.url ? language.t("session.share.copy.copyLink") : language.t("command.session.share"),
        description: info()?.share?.url
          ? language.t("toast.session.share.success.description")
          : language.t("command.session.share.description"),
        slash: "share",
        disabled: !params.id,
        onSelect: share,
      }),
      sessionCommand({
        id: "session.unshare",
        title: language.t("command.session.unshare"),
        description: language.t("command.session.unshare.description"),
        slash: "unshare",
        disabled: !params.id || !info()?.share?.url,
        onSelect: unshare,
      }),
    ]
  }

  const sessionCmds = () => [
    sessionCommand({
      id: "session.new",
      title: language.t("command.session.new"),
      keybind: "mod+shift+s",
      slash: "new",
      onSelect: () => {
        navigate(`/${params.dir}/session`)
      },
    }),
    sessionCommand({
      id: "session.goal",
      title: language.t("command.session.goal"),
      description: language.t("command.session.goal.description"),
      slash: "goal",
      onSelect: () => {
        const text = "/goal "
        prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
        focusInput()
      },
    }),
    sessionCommand({
      id: "session.undo",
      title: language.t("command.session.undo"),
      description: language.t("command.session.undo.description"),
      slash: "undo",
      disabled: !params.id || visibleUserMessages().length === 0,
      onSelect: undo,
    }),
    sessionCommand({
      id: "session.redo",
      title: language.t("command.session.redo"),
      description: language.t("command.session.redo.description"),
      slash: "redo",
      disabled: !params.id || !info()?.revert?.messageID,
      onSelect: redo,
    }),
    sessionCommand({
      id: "session.compact",
      title: language.t("command.session.compact"),
      description: language.t("command.session.compact.description"),
      slash: "compact",
      disabled: !params.id || visibleUserMessages().length === 0,
      onSelect: compact,
    }),
    sessionCommand({
      id: "session.fork",
      title: language.t("command.session.fork"),
      description: language.t("command.session.fork.description"),
      slash: "fork",
      disabled: !params.id || visibleUserMessages().length === 0,
      onSelect: fork,
    }),
    sessionCommand({
      id: "session.children",
      title: language.t("command.session.children"),
      description: language.t("command.session.children.description"),
      slash: "children",
      disabled: !params.id,
      onSelect: openChildSessions,
    }),
  ]

  const viewCmds = () => [
    viewCommand({
      id: "terminal.toggle",
      title: language.t("command.terminal.toggle"),
      keybind: "ctrl+`",
      slash: "terminal",
      onSelect: () => {
        if (view().terminal.opened()) {
          terminal.cancelFocus()
          view().terminal.close()
          return
        }
        terminal.requestFocus(terminal.active())
        view().terminal.open()
      },
    }),
    viewCommand({
      id: "input.focus",
      title: language.t("command.input.focus"),
      keybind: "ctrl+l",
      onSelect: focusInput,
    }),
  ]

  const terminalCmds = () => [
    terminalCommand({
      id: "terminal.close",
      title: language.t("terminal.close"),
      keybind: "mod+w",
      hidden: true,
      when: (event) => event.target instanceof Element && !!event.target.closest('[data-component="terminal"]'),
      onSelect: closeTerminal,
    }),
    terminalCommand({
      id: "terminal.new",
      title: language.t("command.terminal.new"),
      description: language.t("command.terminal.new.description"),
      keybind: "ctrl+alt+t",
      onSelect: openTerminal,
    }),
  ]

  const messageCmds = () => [
    sessionCommand({
      id: "session.find",
      title: language.t("command.session.find"),
      description: language.t("command.session.find.description"),
      keybind: "mod+f",
      disabled: !params.id || !openFind,
      onSelect: () => openFind?.(),
    }),
    sessionCommand({
      id: "message.previous",
      title: language.t("command.message.previous"),
      description: language.t("command.message.previous.description"),
      keybind: "mod+alt+[",
      disabled: !params.id,
      onSelect: () => navigateMessageByOffset(-1),
    }),
    sessionCommand({
      id: "message.next",
      title: language.t("command.message.next"),
      description: language.t("command.message.next.description"),
      keybind: "mod+alt+]",
      disabled: !params.id,
      onSelect: () => navigateMessageByOffset(1),
    }),
  ]

  const mcpCmds = () => [
    mcpCommand({
      id: "mcp.toggle",
      title: language.t("command.mcp.toggle"),
      description: language.t("command.mcp.toggle.description"),
      keybind: "mod+;",
      slash: "mcp",
      onSelect: chooseMcp,
    }),
  ]

  const permissionsCmds = () => [
    permissionsCommand({
      id: "permissions.autoaccept",
      title: isAutoAcceptActive()
        ? language.t("command.permissions.autoaccept.disable")
        : language.t("command.permissions.autoaccept.enable"),
      keybind: "mod+shift+a",
      disabled: false,
      onSelect: toggleAutoAccept,
    }),
  ]

  command.register("session", () => [
    ...sessionCmds(),
    ...shareCmds(),
    ...viewCmds(),
    ...terminalCmds(),
    ...messageCmds(),
    ...mcpCmds(),
    ...permissionsCmds(),
  ])
}
