import { app } from "electron"
import electronUpdater from "electron-updater"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createUpdaterController, type UpdaterReadyRecord } from "./updater-controller"
import { getLogger } from "./logging"

// 启动后先等主界面起来再查，之后每隔一段时间再查一次
const FIRST_CHECK_DELAY = 15_000
const CHECK_INTERVAL = 4 * 60 * 60 * 1000

/**
 * 只有 Windows 安装版启用：更新源是 build.yml 发布的 latest release（generic provider 读其中的 latest.yml）。
 * macOS 包未签名，Squirrel.Mac 不接受未签名的更新包；开发运行与 Linux 也不启用。
 */
function supported() {
  return app.isPackaged && process.platform === "win32" && process.env.OPENCODE_DISABLE_AUTOUPDATE !== "1"
}

export function setupAutoUpdater(stop: () => Promise<void>) {
  const logger = getLogger()
  const enabled = supported()
  logger.log(enabled ? "auto updater enabled" : "auto updater disabled", { currentVersion: app.getVersion() })

  const { autoUpdater } = electronUpdater
  if (enabled) {
    // 由控制器决定何时下载；下载完成后用户没点「安装并重启」，退出应用时也会安装
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.logger = {
      info: (message) => logger.log("updater", { message: String(message) }),
      warn: (message) => logger.warn("updater", { message: String(message) }),
      error: (message) => logger.warn("updater error", { message: String(message) }),
      debug: () => undefined,
    }
  }

  const file = path.join(app.getPath("userData"), "updater-ready.json")
  const controller = createUpdaterController({
    enabled,
    currentVersion: app.getVersion(),
    backend: {
      checkForUpdates: () => autoUpdater.checkForUpdates(),
      downloadUpdate: () => autoUpdater.downloadUpdate(),
      // isSilent=true：NSIS 静默安装；isForceRunAfter=true：装完重新打开
      quitAndInstall: () => autoUpdater.quitAndInstall(true, true),
    },
    persistence: {
      get: () => {
        if (!existsSync(file)) return undefined
        try {
          return JSON.parse(readFileSync(file, "utf8")) as UpdaterReadyRecord
        } catch {
          return undefined
        }
      },
      set: (value) => writeFileSync(file, JSON.stringify(value)),
      clear: () => rmSync(file, { force: true }),
    },
    stop,
    log: (message, data) => logger.log(message, data),
  })

  if (enabled) {
    const run = () => {
      // 已下载待安装时不再重复检查；出错只记日志，下一轮再试
      if (controller.getState().status === "ready") return
      void controller.check()
    }
    setTimeout(() => {
      void controller.start()
      setInterval(run, CHECK_INTERVAL).unref()
    }, FIRST_CHECK_DELAY).unref()
  }

  return controller
}
