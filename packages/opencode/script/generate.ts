import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")
const cacheFile = path.join(dir, ".cache", "models-dev-api.json")
// Reuse a day-old snapshot so desktop predev does not block on models.dev every start.
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000

process.chdir(dir)

const modelsUrl = process.env.OPENCODE_MODELS_URL || "https://models.dev"

export const modelsData = await loadModelsData()
console.log("Loaded models.dev snapshot")

async function loadModelsData() {
  if (process.env.MODELS_DEV_API_JSON) {
    return await Bun.file(process.env.MODELS_DEV_API_JSON).text()
  }

  const cached = readCache()
  if (cached && Date.now() - cached.mtimeMs < CACHE_MAX_AGE_MS) {
    return cached.text
  }

  try {
    const text = await fetch(`${modelsUrl}/api.json`).then((x) => x.text())
    writeCache(text)
    return text
  } catch (error) {
    if (cached) {
      console.warn("models.dev fetch failed; using cached snapshot", error)
      return cached.text
    }
    throw error
  }
}

function readCache() {
  if (!fs.existsSync(cacheFile)) return
  return {
    text: fs.readFileSync(cacheFile, "utf8"),
    mtimeMs: fs.statSync(cacheFile).mtimeMs,
  }
}

function writeCache(text: string) {
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
  fs.writeFileSync(cacheFile, text)
}
