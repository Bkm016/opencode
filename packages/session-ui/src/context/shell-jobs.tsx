import { createContext, useContext } from "solid-js"

/** 后台 shell 作业的宿主能力：卡片只读状态并请求动作，终端面板与 SDK 调用留在应用层。 */
export type ShellJobs = {
  /** 作业（ptyID）当前是否仍在运行；undefined 表示宿主尚未确认 */
  running: (id: string) => boolean | undefined
  /** 终止作业 */
  stop: (id: string) => Promise<void>
  /** 在终端面板中打开（attach 到同一个 PTY） */
  open: (id: string, title: string) => void
}

export const ShellJobsContext = createContext<ShellJobs>()
export const useShellJobs = () => useContext(ShellJobsContext)
