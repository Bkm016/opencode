import { describe, expect, test } from "bun:test"
import { createSdkForServer } from "./server"

describe("createSdkForServer", () => {
  test("sends saved credentials in the authorization header, never the URL", async () => {
    let sent: Request | undefined
    const client = createSdkForServer({
      server: { url: "https://server.example.test", password: "sec:ret" },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        sent = new Request(input, init)
        return Response.json({ healthy: true, version: "test" })
      }) as typeof fetch,
    })
    await client.global.health()
    expect(sent?.headers.get("authorization")).toBe(`Basic ${btoa("opencode:sec:ret")}`)
    expect(sent?.url).toBe("https://server.example.test/global/health")
  })
})
