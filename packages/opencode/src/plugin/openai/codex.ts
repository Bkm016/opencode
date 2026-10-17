import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { OAUTH_DUMMY_KEY } from "../../auth"
import os from "os"
import { createServer } from "http"
import { OpenAIWebSocketPool } from "./ws-pool"
import { OauthCallbackPage } from "@opencode-ai/core/oauth/page"

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const ISSUER = "https://auth.openai.com"
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
const ALLOWED_MODELS = new Set(["gpt-5.5", "gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.4-mini"])
const DISALLOWED_MODELS = new Set(["gpt-5.5-pro"])

// Official ChatGPT token sharing: a user-owned client issued by OpenAI, the
// `chatgpt.tokens.use.direct` scope, and the standard OpenAI API instead of the
// Codex backend. This is what lets a ChatGPT plan bill the normal API surface.
const SHARING_CLIENT_ID = "dynamic_agent_client"
const SHARING_AGENT_NAME = "OpenCode"
const SHARING_TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`
const SHARING_AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`
const SHARING_RESOURCE = "https://api.openai.com/v1"
const SHARING_SCOPE = "chatgpt.tokens.use.direct"
const SHARING_METHOD = "chatgpt-token-sharing"

interface PkceCodes {
  verifier: string
  challenge: string
}

async function generatePKCE(): Promise<PkceCodes> {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(43)))
    .map((b) => chars[b % chars.length])
    .join("")
  const challenge = base64UrlEncode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
  return { verifier, challenge }
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const binary = String.fromCharCode(...bytes)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export interface IdTokenClaims {
  chatgpt_account_id?: string
  organizations?: Array<{ id: string }>
  email?: string
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string
  }
}

export function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString())
  } catch {
    return undefined
  }
}

export function extractAccountIdFromClaims(claims: IdTokenClaims): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  )
}

export function extractAccountId(tokens: TokenResponse): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token)
    const accountId = claims && extractAccountIdFromClaims(claims)
    if (accountId) return accountId
  }
  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token)
    return claims ? extractAccountIdFromClaims(claims) : undefined
  }
  return undefined
}

interface TokenResponse {
  id_token?: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

interface CodexAuthPluginOptions {
  issuer?: string
  codexApiEndpoint?: string
  experimentalWebSockets?: boolean
}

type SharingAuth = {
  type: "oauth"
  access: string
  refresh: string
  expires: number
  accountId?: string
  metadata?: Record<string, string>
}

function isSharingAuth(auth: unknown): auth is SharingAuth {
  if (!auth || typeof auth !== "object") return false
  const value = auth as { type?: string; metadata?: Record<string, string> }
  return value.type === "oauth" && value.metadata?.method === SHARING_METHOD
}

function sharingClientID(auth: unknown) {
  if (!auth || typeof auth !== "object") return undefined
  return (auth as { metadata?: Record<string, string> }).metadata?.clientID
}

async function sharingTokenRequest(body: URLSearchParams) {
  const response = await fetch(SHARING_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": `opencode/${InstallationVersion}` },
    body: body.toString(),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`Token request failed: ${response.status}${detail ? ` ${detail.slice(0, 400)}` : ""}`)
  }
  return (await response.json()) as TokenResponse & { scope?: string }
}

function sharingCredential(tokens: TokenResponse & { scope?: string }, clientID: string, hostID?: string) {
  const claims = tokens.id_token ? parseJwtClaims(tokens.id_token) : undefined
  const accountId = claims ? extractAccountIdFromClaims(claims) : undefined
  return {
    refresh: tokens.refresh_token,
    access: tokens.access_token,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    ...(accountId ? { accountId } : {}),
    metadata: {
      clientID,
      method: SHARING_METHOD,
      scopes: tokens.scope ?? "",
      ...(hostID ? { hostID } : {}),
    } satisfies Record<string, string>,
  }
}

function assertSharingScope(tokens: { scope?: string }) {
  if (!tokens.scope?.split(" ").includes(SHARING_SCOPE)) {
    throw new Error(
      "ChatGPT sign-in finished without token sharing. Sign in again and allow token sharing, or connect OpenAI with an API key.",
    )
  }
}

function decodeIdTokenClaims(token: string) {
  const claims = parseJwtClaims(token) as
    | { nonce?: string; sub?: string; aud?: string | string[]; iss?: string; exp?: number }
    | undefined
  return claims
}

async function verifyIdToken(tokens: TokenResponse, clientID: string, nonce: string) {
  if (!tokens.id_token) throw new Error("ChatGPT sign-in did not return an ID token.")
  const claims = decodeIdTokenClaims(tokens.id_token)
  if (!claims) throw new Error("ChatGPT sign-in returned an unreadable ID token.")
  if (typeof claims.sub !== "string" || !claims.sub.trim()) {
    throw new Error("ChatGPT sign-in returned an ID token without a subject.")
  }
  if (claims.nonce !== nonce) throw new Error("ID token nonce does not match this sign-in attempt.")
  if (claims.iss !== undefined && claims.iss !== ISSUER) {
    throw new Error("ID token was issued by an unexpected issuer.")
  }
  const audience = Array.isArray(claims.aud) ? claims.aud : claims.aud === undefined ? [] : [claims.aud]
  if (claims.aud !== undefined && !audience.includes(clientID)) {
    throw new Error("ID token audience does not match this client.")
  }
  if (typeof claims.exp === "number" && claims.exp * 1000 <= Date.now()) {
    throw new Error("ID token has already expired.")
  }
  const { createRemoteJWKSet, jwtVerify } = await import("jose")
  await jwtVerify(tokens.id_token, createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`)), {
    issuer: ISSUER,
    audience: clientID,
    algorithms: ["RS256"],
    requiredClaims: ["exp", "nonce", "sub"],
  })
}

async function startSharingServer(state: string) {
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1")
    if (url.pathname !== "/auth/callback") {
      res.writeHead(404).end("Not found")
      return
    }
    const error = url.searchParams.get("error_description") ?? url.searchParams.get("error")
    if (error) {
      sharingPending?.reject(new Error(error))
      sharingPending = undefined
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
      res.end(renderOAuthError(error))
      return
    }
    const code = url.searchParams.get("code")
    if (!code || url.searchParams.get("state") !== state) {
      const message = code ? "Invalid OAuth state" : "Missing authorization code"
      sharingPending?.reject(new Error(message))
      sharingPending = undefined
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
      res.end(renderOAuthError(message))
      return
    }
    const clientID = url.searchParams.get("client_id") ?? undefined
    const respond = (error?: string) => {
      if (res.headersSent) return
      res
        .writeHead(error ? 400 : 200, { "Content-Type": "text/html; charset=utf-8" })
        .end(
          error
            ? OauthCallbackPage.error(error, { provider: "ChatGPT" })
            : OauthCallbackPage.success({ provider: "ChatGPT" }),
        )
    }
    sharingPending?.resolve({ code, clientID, respond })
    sharingPending = undefined
  })
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve())
    server.on("error", reject)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing OAuth callback port")
  return {
    redirect: `http://127.0.0.1:${address.port}/auth/callback`,
    close: () => server.close(),
  }
}

type SharingResult = { code: string; clientID?: string; respond: (error?: string) => void }
let sharingPending:
  | { resolve: (value: SharingResult) => void; reject: (error: Error) => void }
  | undefined
let sharingServer: { close: () => void } | undefined

function waitForSharing(): Promise<SharingResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sharingPending = undefined
      reject(new Error("OAuth callback timeout - authorization took too long"))
    }, 5 * 60 * 1000)
    sharingPending = {
      resolve: (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      },
    }
  })
}

async function refreshAccessToken(refreshToken: string, issuer = ISSUER): Promise<TokenResponse> {
  const response = await fetch(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  })
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`)
  }
  return response.json()
}

// Kept as a named export for plugin.codex tests; delegates to the shared branded page.
export const renderOAuthError = (error: string) => OauthCallbackPage.error(error, { provider: "ChatGPT" })

export async function CodexAuthPlugin(input: PluginInput, options: CodexAuthPluginOptions = {}): Promise<Hooks> {
  const issuer = options.issuer ?? ISSUER
  const codexApiEndpoint = options.codexApiEndpoint ?? CODEX_API_ENDPOINT
  let websocketFetchInstalled = false
  let sharingRefresh: Promise<string> | undefined
  let sharedAuth: (() => Promise<unknown>) | undefined
  const websocketFetches: Array<ReturnType<typeof OpenAIWebSocketPool.createWebSocketFetch>> = []

  return {
    async dispose() {
      for (const websocketFetch of websocketFetches) websocketFetch.close()
      websocketFetches.length = 0
    },
    async event(input) {
      if (input.event.type !== "session.deleted") return
      for (const websocketFetch of websocketFetches) websocketFetch.remove(input.event.properties.info.id)
    },
    provider: {
      id: "openai",
      async models(provider, ctx) {
        if (ctx.auth?.type !== "oauth") return provider.models
        if (isSharingAuth(ctx.auth)) {
          return Object.fromEntries(
            Object.entries(provider.models)
              // The OpenAI catalog is user-configured; trust it and only drop
              // models token sharing cannot serve (pro reasoning mode).
              .filter(([, model]) => model.options?.reasoningMode !== "pro")
              .map(([modelID, model]) => {
                return [
                  modelID,
                  {
                    ...model,
                    cost: {
                      input: 0,
                      output: 0,
                      cache: { read: 0, write: 0 },
                    },
                  },
                ]
              }),
          )
        }

        return Object.fromEntries(
          Object.entries(provider.models)
            .filter(([, model]) => {
              if (model.options.reasoningMode === "pro") return false
              if (ALLOWED_MODELS.has(model.api.id)) return true
              if (DISALLOWED_MODELS.has(model.api.id)) return false
              if (model.api.id === "gpt-5.6") return false
              const match = model.api.id.match(/^gpt-(\d+\.\d+)/)
              return match ? parseFloat(match[1]) > 5.4 : false
            })
            .map(([modelID, model]) => [
              modelID,
              {
                ...model,
                cost: {
                  input: 0,
                  output: 0,
                  cache: { read: 0, write: 0 },
                },
                limit: model.id.includes("gpt-5.5")
                  ? {
                      context: 400_000,
                      input: 272_000,
                      output: 128_000,
                    }
                  : model.id.includes("gpt-5.6")
                    ? {
                        context: 500_000,
                        input: 372_000,
                        output: 128_000,
                      }
                    : model.limit,
              },
            ]),
        )
      },
    },
    auth: {
      provider: "openai",
      async loader(getAuth) {
        sharedAuth = () => getAuth()
        const auth = await getAuth()
        if (isSharingAuth(auth)) {
          const clientID = sharingClientID(auth)
          if (!clientID) return {}
          return {
            apiKey: OAUTH_DUMMY_KEY,
            baseURL: SHARING_RESOURCE,
            async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
              const current = await getAuth()
              if (!isSharingAuth(current)) return fetch(requestInput, init)
              const headers = new Headers()
              if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value))
              headers.delete("authorization")
              let access = current.access
              let accountId = current.accountId
              if (!access || current.expires <= Date.now()) {
                // Serialize concurrent refreshes: the old refresh token is single-use.
                const refresh =
                  sharingRefresh ??
                  (sharingRefresh = (async () => {
                    const tokens = await sharingTokenRequest(
                      new URLSearchParams({
                        grant_type: "refresh_token",
                        client_id: clientID,
                        refresh_token: current.refresh,
                        resource: SHARING_RESOURCE,
                      }),
                    )
                    const next = sharingCredential(tokens, clientID, current.metadata?.hostID)
                    const nextAccountId = next.accountId ?? current.accountId
                    await input.client.auth.set({
                      path: { id: "openai" },
                      body: {
                        type: "oauth",
                        refresh: next.refresh,
                        access: next.access,
                        expires: next.expires,
                        ...(nextAccountId ? { accountId: nextAccountId } : {}),
                        metadata: next.metadata,
                      },
                    })
                    accountId = nextAccountId
                    return next.access
                  })().finally(() => {
                    sharingRefresh = undefined
                  }))
                access = await refresh
              }
              headers.set("authorization", `Bearer ${access}`)
              if (accountId) headers.set("ChatGPT-Account-Id", accountId)
              return fetch(requestInput, { ...init, headers })
            },
          }
        }
        const websocketFetch = options.experimentalWebSockets
          ? OpenAIWebSocketPool.createWebSocketFetch({ httpFetch: fetch })
          : undefined
        if (websocketFetch) {
          websocketFetches.push(websocketFetch)
          websocketFetchInstalled = true
        }
        // The sharing branch above narrows `auth`; keep a fresh widened view.
        const authType: string | undefined = auth?.type
        if (authType !== "oauth") return websocketFetch ? { fetch: websocketFetch } : {}

        let refreshPromise:
          | Promise<{
              access: string
              accountId: string | undefined
            }>
          | undefined

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.delete("authorization")
                init.headers.delete("Authorization")
              } else if (Array.isArray(init.headers)) {
                init.headers = init.headers.filter(([key]) => key.toLowerCase() !== "authorization")
              } else {
                delete init.headers["authorization"]
                delete init.headers["Authorization"]
              }
            }

            const currentAuth = await getAuth()
            if (currentAuth.type !== "oauth")
              return websocketFetch ? websocketFetch(requestInput, init) : fetch(requestInput, init)

            const authWithAccount = currentAuth as typeof currentAuth & { accountId?: string }

            if (!currentAuth.access || currentAuth.expires < Date.now()) {
              if (!refreshPromise) {
                refreshPromise = refreshAccessToken(currentAuth.refresh, issuer)
                  .then(async (tokens) => {
                    const accountId = extractAccountId(tokens) || authWithAccount.accountId
                    await input.client.auth.set({
                      path: { id: "openai" },
                      body: {
                        type: "oauth",
                        refresh: tokens.refresh_token,
                        access: tokens.access_token,
                        expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                        ...(accountId && { accountId }),
                      },
                    })
                    return {
                      access: tokens.access_token,
                      accountId,
                    }
                  })
                  .finally(() => {
                    refreshPromise = undefined
                  })
              }

              const refreshed = await refreshPromise
              currentAuth.access = refreshed.access
              authWithAccount.accountId = refreshed.accountId
            }

            const headers = new Headers()
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.forEach((value, key) => headers.set(key, value))
              } else if (Array.isArray(init.headers)) {
                for (const [key, value] of init.headers) {
                  if (value !== undefined) headers.set(key, String(value))
                }
              } else {
                for (const [key, value] of Object.entries(init.headers)) {
                  if (value !== undefined) headers.set(key, String(value))
                }
              }
            }
            headers.set("authorization", `Bearer ${currentAuth.access}`)
            if (authWithAccount.accountId) {
              headers.set("ChatGPT-Account-Id", authWithAccount.accountId)
            }

            const parsed =
              requestInput instanceof URL
                ? requestInput
                : new URL(typeof requestInput === "string" ? requestInput : requestInput.url)
            const url =
              parsed.pathname.includes("/v1/responses") || parsed.pathname.includes("/chat/completions")
                ? new URL(codexApiEndpoint)
                : parsed

            const requestInit = {
              ...init,
              body: init?.body,
              headers,
            }
            if (websocketFetch && parsed.pathname.endsWith("/responses")) return websocketFetch(url, requestInit)
            return fetch(url, OpenAIWebSocketPool.withoutInternalHeaders(requestInit))
          },
        }
      },
    methods: [
      {
        label: "Sign in with ChatGPT",
        type: "oauth",
        authorize: async () => {
          const pkce = await generatePKCE()
          const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
          const nonce = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
          const previous = (await sharedAuth?.()) as { metadata?: Record<string, string> } | undefined
          // Reuse the registered client and agent host so re-login does not look
          // like a brand new third-party agent to OpenAI.
          const savedClientID =
            previous?.metadata?.method === SHARING_METHOD ? previous?.metadata?.clientID : undefined
          const hostID = previous?.metadata?.hostID ?? `urn:uuid:${crypto.randomUUID()}`
          // A new attempt supersedes any previous one: close its loopback server
          // and fail its waiter so a stale callback cannot hit the new state.
          sharingServer?.close()
          sharingServer = undefined
          sharingPending?.reject(new Error("ChatGPT sign-in was restarted"))
          sharingPending = undefined
          const server = await startSharingServer(state)
          sharingServer = server
          // Register the waiter before exposing the URL: the browser can hit the
          // callback before the UI calls `callback()`, and an unregistered waiter
          // would drop the code and hang until the timeout.
          const pending = waitForSharing()
          // The UI may abandon this attempt without ever calling `callback()`.
          // Close the loopback server and suppress the unhandled rejection.
          void pending.catch(() => {
            server.close()
            if (sharingServer === server) sharingServer = undefined
          })
          return {
            url: `${SHARING_AUTHORIZE_URL}?${new URLSearchParams({
              client_id: savedClientID ?? SHARING_CLIENT_ID,
              ...(savedClientID ? {} : { agent_name_hint: SHARING_AGENT_NAME }),
              ext_agent_host_id: hostID,
              response_type: "code",
              redirect_uri: server.redirect,
              scope: `openid profile email offline_access resource.invoke ${SHARING_SCOPE}`,
              resource: SHARING_RESOURCE,
              state,
              nonce,
              code_challenge_method: "S256",
              code_challenge: pkce.challenge,
            })}`,
            instructions: "Complete authorization in your browser. This window will close automatically.",
            method: "auto" as const,
            callback: async () => {
              let result: SharingResult | undefined
              try {
                result = await pending
                if (savedClientID && result.clientID && result.clientID !== savedClientID) {
                  throw new Error("ChatGPT returned a different client than this connection. Connect again.")
                }
                const clientID = savedClientID ?? result.clientID
                if (!clientID) throw new Error("ChatGPT sign-in did not return a client ID. Connect again.")
                const tokens = await sharingTokenRequest(
                  new URLSearchParams({
                    grant_type: "authorization_code",
                    client_id: clientID,
                    code: result.code,
                    code_verifier: pkce.verifier,
                    redirect_uri: server.redirect,
                    resource: SHARING_RESOURCE,
                  }),
                )
                assertSharingScope(tokens)
                await verifyIdToken(tokens, clientID, nonce)
                const value = { type: "success" as const, ...sharingCredential(tokens, clientID, hostID) }
                result.respond()
                return value
              } catch (error) {
                result?.respond(error instanceof Error ? error.message : "ChatGPT sign-in failed")
                return { type: "failed" as const }
              } finally {
                server.close()
                if (sharingServer === server) sharingServer = undefined
              }
            },
          }
        },
      },
      {
        label: "Manually enter API Key",
        type: "api",
      },
    ],
    },
    "chat.headers": async (input, output) => {
      if (input.model.providerID !== "openai") return
      output.headers.originator = "opencode"
      output.headers["User-Agent"] = `opencode/${InstallationVersion} (${os.platform()} ${os.release()}; ${os.arch()})`
      output.headers["session-id"] = input.sessionID
      // Temporary fetch-layer hack: title generation currently shares the conversation
      // session ID, so the OpenAI plugin marks it for HTTP fallback until transport
      // context can be passed directly instead of smuggled through headers.
      if (websocketFetchInstalled && input.agent === "title") output.headers[OpenAIWebSocketPool.TITLE_HEADER] = "true"
    },
    "chat.params": async (input, output) => {
      if (input.model.providerID !== "openai") return
      // Match codex cli
      output.maxOutputTokens = undefined
    },
  }
}
