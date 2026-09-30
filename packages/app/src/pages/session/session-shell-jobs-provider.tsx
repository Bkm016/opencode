import { createEffect, createSignal, onCleanup, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { ShellJobsContext, type ShellJobs } from "@opencode-ai/session-ui/context/shell-jobs"
import { useSDK } from "@/context/sdk"
import { useTerminal } from "@/context/terminal"
import { useSessionLayout } from "./session-layout"
import { terminalWebSocketURL } from "@/utils/terminal-websocket-url"

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
    // 只读连接：从游标 0 回放缓冲再接收实时输出，不发送尺寸与输入，不影响终端面板
    watch: (id, onData) => {
      const current = sdk()
      let socket: WebSocket | undefined
      let closed = false
      void current.client.pty
        .connectToken(
          { ptyID: id, directory: current.directory },
          { throwOnError: false, headers: { "x-opencode-ticket": "1" } },
        )
        .then((result) => {
          const ticket = result.response.status === 200 ? result.data?.ticket : undefined
          if (closed || !ticket) return
          socket = new WebSocket(
            terminalWebSocketURL({ url: current.url, id, directory: current.directory, cursor: 0, ticket }),
          )
          socket.binaryType = "arraybuffer"
          socket.addEventListener("message", (event) => {
            // 二进制帧是游标控制帧，只取文本输出
            if (typeof event.data === "string" && event.data) onData(event.data)
          })
        })
        .catch(() => {})
      return () => {
        closed = true
        if (socket && socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) socket.close(1000)
      }
    },
  }

  return <ShellJobsContext.Provider value={value}>{props.children}</ShellJobsContext.Provider>
}
