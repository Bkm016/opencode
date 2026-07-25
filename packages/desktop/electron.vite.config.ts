import { sentryVitePlugin } from "@sentry/vite-plugin"
import { defineConfig } from "electron-vite"
import appPlugin from "@opencode-ai/app/vite"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const packageDir = path.dirname(fileURLToPath(import.meta.url))
const OPENCODE_SERVER_DIST = path.resolve(packageDir, "../opencode/dist/node")
const SERVER_OUT = path.resolve(packageDir, "out/main/server")

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (process.env.OPENCODE_CHANNEL === "latest") return "prod"
  return "prod"
})()

const nodePtyPkg = `@lydell/node-pty-${process.platform}-${process.arch}`

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
          assets: "./out/renderer/**",
          filesToDeleteAfterUpload: "./out/renderer/**/*.map",
        },
      })
    : false

async function copyServerDist() {
  await fs.mkdir(SERVER_OUT, { recursive: true })
  // Skip linked sourcemaps (~50MB) — runtime only needs JS + wasm.
  const entries = await fs.readdir(OPENCODE_SERVER_DIST)
  await Promise.all(
    entries.map(async (name) => {
      if (name.endsWith(".map")) return
      const from = path.join(OPENCODE_SERVER_DIST, name)
      const to = path.join(SERVER_OUT, name)
      const [src, dst] = await Promise.all([
        fs.stat(from),
        fs.stat(to).catch(() => undefined),
      ])
      if (dst && dst.size === src.size && dst.mtimeMs >= src.mtimeMs) return
      await fs.copyFile(from, to)
    }),
  )
  // Server bundle leaves these packages external. Copy them next to node.js so
  // Node can resolve them from out/main/server at runtime (including packaged asar).
  await copyServerNodeModule("jsonc-parser")
  await copyServerNodeModule("@lydell/node-pty")
  await copyServerNodeModule(nodePtyPkg)
}

async function resolveNodeModule(name: string) {
  // Bun installs packages as junctions into node_modules/.bun/...; resolve the
  // real path so Windows fs.cp does not hit ENOTDIR on junctions.
  const parts = name.split("/")
  const candidates = [
    path.resolve(packageDir, "node_modules", ...parts),
    path.resolve(packageDir, "../opencode/node_modules", ...parts),
    path.resolve(packageDir, "../core/node_modules", ...parts),
    path.resolve(packageDir, "../../node_modules", ...parts),
  ]
  for (const dir of candidates) {
    try {
      const st = await fs.stat(dir)
      if (st.isDirectory()) return await fs.realpath(dir)
    } catch {
      // try next
    }
  }
  return undefined
}

async function copyServerNodeModule(name: string) {
  const src = await resolveNodeModule(name)
  if (!src) {
    throw new Error(
      `${name} not found (expected under packages/desktop, opencode, core, or repo root node_modules)`,
    )
  }
  const to = path.join(SERVER_OUT, "node_modules", ...name.split("/"))
  await fs.rm(to, { recursive: true, force: true })
  await fs.mkdir(path.dirname(to), { recursive: true })
  await fs.cp(src, to, { recursive: true })
}

export default defineConfig({
  main: {
    define: {
      "import.meta.env.OPENCODE_CHANNEL": JSON.stringify(channel),
    },
    build: {
      rollupOptions: {
        input: { index: "src/main/index.ts", sidecar: "src/main/sidecar.ts" },
        // Keep this identical to electron-vite's Node 20.11+ shim. Its regex insertion can
        // corrupt bundled TypeScript, while a Rollup banner places the shim safely.
        output: {
          banner: `
// -- CommonJS Shims --
import __cjs_mod__ from 'node:module';
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require = __cjs_mod__.createRequire(import.meta.url);
`,
        },
      },
      externalizeDeps: { include: [nodePtyPkg] },
    },
    plugins: [
      {
        name: "opencode:node-pty-narrower",
        enforce: "pre",
        resolveId(s) {
          if (s === "@lydell/node-pty") return nodePtyPkg
        },
      },
      {
        name: "opencode:copy-server-dist",
        // Prebuilt server is ~30MB; copy next to sidecar and load at runtime (no Rollup reparse).
        async buildStart() {
          await copyServerDist()
        },
        async writeBundle() {
          await copyServerDist()
        },
      },
    ],
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    plugins: [appPlugin, sentry],
    publicDir: "../../../app/public",
    root: "src/renderer",
    build: {
      sourcemap: true,
      rollupOptions: {
        input: {
          main: "src/renderer/index.html",
        },
      },
    },
  },
})
