import { describe, expect, test } from "bun:test"
import { ProviderResponseDump } from "../src/response-dump"

describe("ProviderResponseDump", () => {
  test("records last response per session", () => {
    ProviderResponseDump.record({
      sessionID: "ses_resp_a",
      model: "glm-5.2",
      provider: "sky",
      route: "responses",
      protocol: "openai-responses",
      status: 200,
      body: 'data: {"type":"response.created"}\n\n',
      runtime: "native",
    })
    expect(ProviderResponseDump.get("ses_resp_a")?.status).toBe(200)
    expect(ProviderResponseDump.get("ses_resp_a")?.body).toBe('data: {"type":"response.created"}\n\n')

    ProviderResponseDump.record({
      sessionID: "ses_resp_a",
      model: "glm-5.2",
      provider: "sky",
      route: "responses",
      protocol: "openai-responses",
      body: { error: { message: "rate limited" } },
      status: 429,
      error: true,
    })
    expect(ProviderResponseDump.get("ses_resp_a")?.error).toBe(true)
    expect(ProviderResponseDump.get("ses_resp_a")?.status).toBe(429)
  })

  test("parses complete JSON string body", () => {
    ProviderResponseDump.record({
      sessionID: "ses_resp_json",
      model: "gpt",
      provider: "openai",
      route: "ai-sdk",
      protocol: "ai-sdk",
      body: '{"id":"resp_1","status":"completed"}',
    })
    expect(ProviderResponseDump.get("ses_resp_json")?.body).toEqual({ id: "resp_1", status: "completed" })
  })

  test("filename is stable and filesystem-safe", () => {
    const snap = ProviderResponseDump.record({
      sessionID: "ses_resp_name",
      model: "foo/bar:baz",
      provider: "p",
      route: "responses",
      protocol: "openai-responses",
      body: "",
    })
    expect(snap).toBeDefined()
    const name = ProviderResponseDump.filename(snap!)
    expect(name).toMatch(/_responses_foo_bar_baz_response\.json$/)
    expect(name).not.toContain("/")
    expect(name).not.toContain(":")
  })

  test("decodeChunks merges utf-8 bytes", () => {
    const text = "hello 世界"
    const bytes = new TextEncoder().encode(text)
    expect(ProviderResponseDump.decodeChunks([bytes.slice(0, 3), bytes.slice(3)])).toBe(text)
  })
})
