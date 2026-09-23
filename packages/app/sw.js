// Emitted as /sw.js by the web build (see vite.config.ts), which stamps the cache version below.
// Only content-hashed build output under /assets/ is cached. Navigations, API calls, SSE and
// WebSocket traffic are never intercepted, so server auth prompts and live data behave as without it.
const PREFIX = "opencode-assets-"
const CACHE = PREFIX + "__OPENCODE_SW_VERSION__"

self.addEventListener("install", () => {
  self.skipWaiting()
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key.startsWith(PREFIX) && key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener("fetch", (event) => {
  const request = event.request
  if (request.method !== "GET") return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || !url.pathname.startsWith("/assets/")) return

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(request)
      if (hit) return hit
      const response = await fetch(request)
      // The server answers unknown paths with index.html, so never cache an HTML fallback as an asset.
      if (response.ok && !response.headers.get("content-type")?.includes("text/html")) {
        void cache.put(request, response.clone())
      }
      return response
    }),
  )
})
