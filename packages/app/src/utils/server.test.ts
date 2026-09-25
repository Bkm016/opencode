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

  test("sends custom headers such as Cloudflare Access service tokens", async () => {
    let sent: Request | undefined
    const client = createSdkForServer({
      server: {
        url: "https://oc9950.example.test",
        headers: {
          "CF-Access-Client-Id": "id.access",
          "CF-Access-Client-Secret": "secret",
        },
      },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        sent = new Request(input, init)
        return Response.json({ healthy: true, version: "test" })
      }) as typeof fetch,
    })
    await client.global.health()
    expect(sent?.headers.get("cf-access-client-id")).toBe("id.access")
    expect(sent?.headers.get("cf-access-client-secret")).toBe("secret")
  })
})
