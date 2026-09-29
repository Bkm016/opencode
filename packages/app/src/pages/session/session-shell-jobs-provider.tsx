import { createEffect, createSignal, onCleanup, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { ShellJobsContext, type ShellJobs } from "@opencode-ai/session-ui/context/shell-jobs"
import { useSDK } from "@/context/sdk"
import { useTerminal } from "@/context/terminal"
import { useSessionLayout } from "./session-layout"

/** 为后台 bash 卡片提供 PTY 运行状态、停止与「在终端中打开」能力。 */
export function SessionShellJobsProvider(props: ParentProps) {
  const sdk = useSDK()
  const terminal = useTerminal()
  const { view } = useSessionLayout()
  const [running, setRunning] = createStore<Record<string, boolean>>({})
  const [loaded, setLoaded] = createSignal(false)

  createEffect(() => {
    const current = sdk()
    const client = current.client
    let alive = true
    setLoaded(false)
    const off = [
      current.event.on("pty.created", (event) => setRunning(event.properties.info.id, true)),
      current.event.on("pty.updated", (event) =>
        setRunning(event.properties.info.id, event.properties.info.status === "running"),
      ),
      current.event.on("pty.exited", (event) => setRunning(event.properties.id, false)),
      current.event.on("pty.deleted", (event) => setRunning(event.properties.id, false)),
    ]
    void client.pty
      .list()
      .then((result) => {
        if (!alive) return
        for (const info of result.data ?? []) setRunning(info.id, info.status === "running")
        setLoaded(true)
      })
      .catch(() => {})
    onCleanup(() => {
      alive = false
      off.forEach((unsubscribe) => unsubscribe())
    })
  })

  const value: ShellJobs = {
    running: (id) => (loaded() ? running[id] === true : undefined),
    stop: async (id) => {
      await sdk().client.pty.remove({ ptyID: id })
      setRunning(id, false)
    },
    open: (id, title) => {
      terminal.adopt({ id, title })
      view().terminal.open()
    },
  }

  return <ShellJobsContext.Provider value={value}>{props.children}</ShellJobsContext.Provider>
}
