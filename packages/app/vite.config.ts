import { sentryVitePlugin } from "@sentry/vite-plugin"
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { defineConfig, type Plugin } from "vite"
import desktopPlugin from "./vite"

const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./dist/**",
          filesToDeleteAfterUpload: "./dist/**/*.map",
        },
      })
    : false

// Web-only PWA service worker. The version changes whenever the hashed build output or the unhashed
// files in public/assets change, so each build gets a fresh asset cache and stale ones are dropped.
const serviceWorker: Plugin = {
  name: "opencode-app:service-worker",
  apply: "build",
  generateBundle(_options, bundle) {
    const hash = createHash("sha256").update(Object.keys(bundle).sort().join("\n"))
    const assets = new URL("./public/assets/", import.meta.url)
    readdirSync(assets)
      .sort()
      .forEach((file) => hash.update(file).update(readFileSync(new URL(file, assets))))
    this.emitFile({
      type: "asset",
      fileName: "sw.js",
      source: readFileSync(new URL("./sw.js", import.meta.url), "utf8").replaceAll(
        "__OPENCODE_SW_VERSION__",
        hash.digest("hex").slice(0, 16),
      ),
    })
  },
}

export default defineConfig({
  plugins: [desktopPlugin, serviceWorker, sentry] as any,
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3000,
  },
  build: {
    target: "esnext",
    sourcemap: true,
  },
})
