import { app } from "electron"
import { createUpdaterController } from "./updater-controller"
import { getLogger } from "./logging"

export function setupAutoUpdater(stop: () => Promise<void>) {
  const logger = getLogger()
  logger.log("auto updater disabled", { currentVersion: app.getVersion() })

  // No-op backend: never call electron-updater network APIs.
  return createUpdaterController({
    enabled: false,
    currentVersion: app.getVersion(),
    backend: {
      checkForUpdates: async () => null,
      downloadUpdate: async () => undefined,
      quitAndInstall: () => undefined,
    },
    persistence: {
      get: () => undefined,
      set: () => undefined,
      clear: () => undefined,
    },
    stop,
    log: (message, data) => logger.log(message, data),
  })
}
