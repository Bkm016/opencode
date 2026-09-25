import { afterAll, describe, expect, test } from "bun:test"
import { createFetchProxy, type FetchProxySink } from "./fetch-proxy"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

// 模拟 /event：先推一条事件，然后保持连接不结束。
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/json") return Response.json({ ok: true })
    if (url.pathname === "/empty") return new Response(null, { status: 204 })
    if (url.pathname === "/echo") return new Response(request.body)
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"server.connected"}\n\n'))
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
afterAll(() => server.stop(true))

const base = `http://127.0.0.1:${server.port}`

function collect() {
  const chunks: string[] = []
  const state = { ended: false, error: undefined as string | undefined }
  const sink: FetchProxySink = {
    chunk: (data) => chunks.push(decoder.decode(data)),
    end: () => {
      state.ended = true
    },
    error: (message) => {
      state.error = message
    },
  }
  return { chunks, state, sink }
}

const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(10)
  expect(check()).toBe(true)
}

describe("createFetchProxy", () => {
  test("delivers SSE chunks before the stream ends", async () => {
    const proxy = createFetchProxy(fetch)
    const { chunks, state, sink } = collect()
    const head = await proxy.start("1:a", `${base}/event`, {}, sink)

    expect(head.status).toBe(200)
    expect(head.headers["content-type"]).toBe("text/event-stream")
    await waitFor(() => chunks.join("").includes("server.connected"))
    expect(state.ended).toBe(false)

    proxy.abort("1:a")
    await Bun.sleep(20)
    expect(proxy.size()).toBe(0)
    expect(state.error).toBeUndefined()
  })

  test("ends finite bodies and forwards binary request bodies", async () => {
    const proxy = createFetchProxy(fetch)
    const { chunks, state, sink } = collect()
    await proxy.start("1:b", `${base}/echo`, { method: "POST", body: new Uint8Array([0xe4, 0xbd, 0xa0]) }, sink)
    await waitFor(() => state.ended)
    expect(chunks.join("")).toBe("你")
    expect(proxy.size()).toBe(0)
  })

  test("ends null-body responses immediately", async () => {
    const proxy = createFetchProxy(fetch)
    const { state, sink } = collect()
    const head = await proxy.start("1:c", `${base}/empty`, {}, sink)
    expect(head.status).toBe(204)
    await waitFor(() => state.ended)
    expect(proxy.size()).toBe(0)
  })

  test("aborts every request of a destroyed sender", async () => {
    const proxy = createFetchProxy(fetch)
    await proxy.start("7:a", `${base}/event`, {}, collect().sink)
    await proxy.start("7:b", `${base}/event`, {}, collect().sink)
    await proxy.start("8:a", `${base}/event`, {}, collect().sink)
    proxy.abortPrefix("7:")
    expect(proxy.size()).toBe(1)
    proxy.abort("8:a")
    expect(proxy.size()).toBe(0)
  })

  test("rejects and forgets requests that fail before headers", async () => {
    const proxy = createFetchProxy(fetch)
    await expect(proxy.start("1:d", "http://127.0.0.1:1/", {}, collect().sink)).rejects.toBeDefined()
    expect(proxy.size()).toBe(0)
  })
})
