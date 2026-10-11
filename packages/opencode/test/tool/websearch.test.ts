import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { parseResponse, parseResult } from "../../src/tool/mcp-websearch"
import {
  cooldownMillis,
  pickWebSearchProvider,
  resetWebSearchState,
  resolveWebSearchChoice,
  webSearchErrorMessage,
  webSearchModelName,
  webSearchProviderLabel,
} from "../../src/tool/websearch"
import { format, parseExa, parseFirecrawl, parseParallel, parseTinyFish, search } from "../../src/tool/websearch-providers"

import { webSearchEnabled } from "../../src/tool/registry"
import { it } from "../lib/effect"

const SESSION_ID = "ses_0196aabbccddeeff001122334455"

function withOverride(value: string | undefined, fn: () => void) {
  const original = process.env.OPENCODE_WEBSEARCH_PROVIDER
  try {
    if (value === undefined) delete process.env.OPENCODE_WEBSEARCH_PROVIDER
    else process.env.OPENCODE_WEBSEARCH_PROVIDER = value
    fn()
  } finally {
    if (original === undefined) delete process.env.OPENCODE_WEBSEARCH_PROVIDER
    else process.env.OPENCODE_WEBSEARCH_PROVIDER = original
  }
}

function httpError(status: number, headers: Record<string, string> = {}) {
  const request = HttpClientRequest.get("https://example.com")
  return new HttpClientError.HttpClientError({
    reason: new HttpClientError.StatusCodeError({
      request,
      response: HttpClientResponse.fromWeb(request, new Response(null, { status, headers })),
    }),
  })
}

describe("websearch provider choice", () => {
  test("defaults to random", () => {
    withOverride(undefined, () => {
      expect(resolveWebSearchChoice(undefined)).toBe("random")
      expect(resolveWebSearchChoice({})).toBe("random")
    })
  })

  test("prefers config over legacy flags", () => {
    withOverride(undefined, () => {
      expect(resolveWebSearchChoice({ provider: "tavily" }, { exa: true, parallel: true })).toBe("tavily")
      expect(resolveWebSearchChoice(undefined, { exa: true, parallel: false })).toBe("exa")
      expect(resolveWebSearchChoice(undefined, { exa: false, parallel: true })).toBe("parallel")
    })
  })

  test("supports an operational override", () => {
    withOverride("firecrawl", () => expect(resolveWebSearchChoice({ provider: "exa" })).toBe("firecrawl"))
    withOverride("random", () => expect(resolveWebSearchChoice({ provider: "exa" })).toBe("random"))
    withOverride("bogus", () => expect(resolveWebSearchChoice({ provider: "exa" })).toBe("exa"))
  })

  test("is enabled by default unless explicitly disabled", () => {
    expect(webSearchEnabled()).toBe(true)
    expect(webSearchEnabled({})).toBe(true)
    expect(webSearchEnabled({ provider: "random" })).toBe(true)
    expect(webSearchEnabled(false)).toBe(false)
  })

  test("uses branded labels", () => {
    expect(webSearchProviderLabel("parallel")).toBe("Parallel Web Search")
    expect(webSearchProviderLabel("exa")).toBe("Exa Web Search")
    expect(webSearchProviderLabel("tinyfish")).toBe("TinyFish Web Search")
    expect(webSearchProviderLabel(undefined)).toBe("Web Search")
  })

  test("uses the provider API model id for Parallel analytics", () => {
    expect(
      webSearchModelName({
        model: {
          id: "claude-opus-4-7",
          api: { id: "claude-opus-4.7" },
        },
      }),
    ).toBe("claude-opus-4.7")
  })
})

describe("websearch random mode", () => {
  afterEach(() => resetWebSearchState())

  test("sticks to one provider per session", () => {
    const first = pickWebSearchProvider(SESSION_ID, 0)
    expect(first).toBeDefined()
    expect(pickWebSearchProvider(SESSION_ID, 1)).toBe(first)
  })

  test("fails over to untried providers and runs out", () => {
    const attempted = new Set<NonNullable<ReturnType<typeof pickWebSearchProvider>>>()
    for (let i = 0; i < 5; i++) {
      const next = pickWebSearchProvider(SESSION_ID, 0, attempted)
      expect(next).toBeDefined()
      expect(attempted.has(next!)).toBe(false)
      attempted.add(next!)
    }
    expect(pickWebSearchProvider(SESSION_ID, 0, attempted)).toBeUndefined()
  })

  test("cooldown honors retry-after on 429", () => {
    expect(cooldownMillis(httpError(429, { "retry-after": "5" }), 0)).toBe(5_000)
    expect(cooldownMillis(httpError(429, { "retry-after": new Date(30_000).toUTCString() }), 0)).toBe(30_000)
    expect(cooldownMillis(httpError(429), 0)).toBe(60_000)
    expect(cooldownMillis(httpError(500, { "retry-after": "5" }), 0)).toBe(60_000)
    expect(cooldownMillis(new Error("timeout"), 0)).toBe(60_000)
  })

  test("describes failures", () => {
    expect(webSearchErrorMessage("tavily", httpError(429))).toBe("Tavily web search rate limited (HTTP 429)")
    expect(webSearchErrorMessage("exa", httpError(401))).toBe("Exa web search authentication failed (HTTP 401)")
    expect(webSearchErrorMessage("firecrawl", httpError(502))).toBe("Firecrawl web search request failed (HTTP 502)")
    expect(webSearchErrorMessage("tinyfish", new Error("timed out"))).toBe("TinyFish web search failed: timed out")
  })
})

describe("websearch result parsers", () => {
  test("parses Exa text blocks", () => {
    const text = [
      "Title: Bun 1.3\nURL: https://bun.com/blog/bun-v1.3\nPublished: 2025-10-10T00:00:00.000Z\nAuthor: N/A\nHighlights:\nBiggest release yet",
      "Title: N/A\nURL: https://example.com\nPublished: N/A\nHighlights:\n",
    ].join("\n\n---\n\n")
    expect(parseExa(text)).toEqual([
      {
        url: "https://bun.com/blog/bun-v1.3",
        title: "Bun 1.3",
        content: "Biggest release yet",
        published: Date.parse("2025-10-10T00:00:00.000Z"),
      },
      { url: "https://example.com" },
    ])
  })

  test("parses Parallel structured content and text fallback", () => {
    const response = {
      results: [{ url: "https://bun.sh", title: "Bun", publish_date: null, excerpts: ["a", "b"] }],
    }
    const expected = [{ url: "https://bun.sh", title: "Bun", content: "a\n\nb" }]
    expect(parseParallel({ content: [], structuredContent: response })).toEqual(expected)
    expect(parseParallel({ content: [{ type: "text", text: JSON.stringify(response) }] })).toEqual(expected)
  })

  test("parses Firecrawl and TinyFish JSON text", () => {
    expect(
      parseFirecrawl(
        JSON.stringify({ success: true, data: { web: [{ url: "https://a.dev", title: "A", description: "d" }] } }),
      ),
    ).toEqual([{ url: "https://a.dev", title: "A", content: "d" }])
    expect(
      parseTinyFish(
        JSON.stringify({ results: [{ url: "https://b.dev", title: "B", snippet: "s", date: "Oct 10, 2025" }] }),
      ),
    ).toEqual([{ url: "https://b.dev", title: "B", content: "s", published: Date.parse("Oct 10, 2025") }])
    expect(parseFirecrawl("You've hit Firecrawl's free MCP rate limit.")).toBeUndefined()
  })

  test("formats results as markdown", () => {
    expect(
      format([
        { url: "https://a.dev", title: "A", content: "body", published: Date.parse("2025-01-02T00:00:00.000Z") },
        { url: "https://b.dev" },
      ]),
    ).toBe("## [A](https://a.dev)\nPublished: 2025-01-02T00:00:00.000Z\n\nbody\n\n## [https://b.dev](https://b.dev)")
  })
})

describe("websearch provider requests", () => {
  const input = { query: "bun", numResults: 2, sessionID: SESSION_ID, exa: { type: "auto", livecrawl: "fallback" } }
  const fake = (status: number, body: unknown) =>
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status }))),
    )
  const mcp = (text: string, extra: Record<string, unknown> = {}) => ({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text }], ...extra },
  })

  it.effect("fails when a keyless quota message comes back as HTTP 200", () =>
    Effect.gen(function* () {
      const result = yield* search(
        fake(200, mcp("You've hit Firecrawl's free MCP rate limit.\n\nFix: ...")),
        "firecrawl",
        input,
      ).pipe(Effect.flip)
      expect(String(result)).toContain("free MCP rate limit")
    }),
  )

  it.effect("fails on MCP isError", () =>
    Effect.gen(function* () {
      const result = yield* search(fake(200, mcp("boom", { isError: true })), "exa", input).pipe(Effect.flip)
      expect(String(result)).toContain("boom")
    }),
  )

  it.effect("surfaces HTTP 429 as an HttpClientError", () =>
    Effect.gen(function* () {
      const error = yield* search(fake(429, {}), "tavily", input).pipe(Effect.flip)
      expect(webSearchErrorMessage("tavily", error)).toBe("Tavily web search rate limited (HTTP 429)")
    }),
  )

  it.effect("limits results to numResults", () =>
    Effect.gen(function* () {
      const results = yield* search(
        fake(200, mcp(JSON.stringify({ results: [1, 2, 3].map((i) => ({ url: `https://${i}.dev`, title: `${i}` })) }))),
        "tinyfish",
        input,
      )
      expect(results.map((item) => item.url)).toEqual(["https://1.dev", "https://2.dev"])
    }),
  )
})

describe("websearch MCP response parser", () => {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [
        {
          type: "text",
          text: "search results",
        },
      ],
    },
  })

  it.effect("parses plain JSON-RPC responses", () =>
    Effect.gen(function* () {
      const result = yield* parseResponse(payload)
      expect(result).toBe("search results")
    }),
  )

  it.effect("parses SSE JSON-RPC responses", () =>
    Effect.gen(function* () {
      const result = yield* parseResponse(`event: message\ndata: ${payload}\n\n`)
      expect(result).toBe("search results")
    }),
  )

  it.effect("ignores non-JSON SSE data frames", () =>
    Effect.gen(function* () {
      const result = yield* parseResponse(`data: [DONE]\ndata: ${payload}\n\n`)
      expect(result).toBe("search results")
    }),
  )

  it.effect("keeps structured content", () =>
    Effect.gen(function* () {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [], structuredContent: { ok: 1 } } })
      const result = yield* parseResult(body)
      expect(result?.structuredContent).toEqual({ ok: 1 })
    }),
  )
})
