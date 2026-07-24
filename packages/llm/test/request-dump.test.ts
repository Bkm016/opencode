import { describe, expect, test } from "bun:test"
import { ProviderRequestDump } from "../src/request-dump"

describe("ProviderRequestDump", () => {
  test("records last request per session", () => {
    const first = ProviderRequestDump.record({
      sessionID: "ses_test_a",
      model: "glm-5.2",
      provider: "sky",
      route: "responses",
      protocol: "openai-responses",
      body: { model: "glm-5.2", input: [{ role: "user", content: "hi" }] },
      runtime: "native",
    })
    expect(first?.sessionID).toBe("ses_test_a")
    expect(ProviderRequestDump.get("ses_test_a")?.body).toEqual({
      model: "glm-5.2",
      input: [{ role: "user", content: "hi" }],
    })

    ProviderRequestDump.record({
      sessionID: "ses_test_a",
      model: "glm-5.2",
      provider: "sky",
      route: "responses",
      protocol: "openai-responses",
      body: { model: "glm-5.2", input: [{ role: "user", content: "second" }] },
    })
    expect((ProviderRequestDump.get("ses_test_a")?.body as { input: Array<{ content: string }> }).input[0]?.content).toBe(
      "second",
    )
  })

  test("parses JSON string body", () => {
    ProviderRequestDump.record({
      sessionID: "ses_test_json",
      model: "gpt",
      provider: "openai",
      route: "ai-sdk",
      protocol: "ai-sdk",
      body: '{"model":"gpt","stream":true}',
    })
    expect(ProviderRequestDump.get("ses_test_json")?.body).toEqual({ model: "gpt", stream: true })
  })

  test("filename is stable and filesystem-safe", () => {
    const snap = ProviderRequestDump.record({
      sessionID: "ses_name",
      model: "foo/bar:baz",
      provider: "p",
      route: "responses",
      protocol: "openai-responses",
      body: {},
    })
    expect(snap).toBeDefined()
    const name = ProviderRequestDump.filename(snap!)
    expect(name).toMatch(/_responses_foo_bar_baz\.json$/)
    expect(name).not.toContain("/")
    expect(name).not.toContain(":")
  })
})