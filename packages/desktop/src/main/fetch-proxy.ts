export type FetchProxyInit = {
  method?: string
  headers?: Record<string, string>
  body?: Uint8Array
}

export type FetchProxyHead = {
  status: number
  statusText: string
  headers: Record<string, string>
}

export type FetchProxySink = {
  chunk: (data: Uint8Array) => void
  end: () => void
  error: (message: string) => void
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>

// 主进程代发请求：先返回响应头，再把 body 分块推给 renderer。
// 不能整体缓冲 body，否则 /event 这类永不结束的 SSE 流永远到不了前端。
export function createFetchProxy(fetcher: Fetcher) {
  const inflight = new Map<string, AbortController>()

  const pump = async (
    key: string,
    controller: AbortController,
    body: ReadableStream<Uint8Array>,
    sink: FetchProxySink,
  ) => {
    const reader = body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value.byteLength > 0) sink.chunk(value)
      }
      sink.end()
    } catch (error) {
      // renderer 主动中止时它已自行结束流，无需回报。
      if (!controller.signal.aborted) sink.error(error instanceof Error ? error.message : String(error))
    } finally {
      if (inflight.get(key) === controller) inflight.delete(key)
    }
  }

  return {
    async start(key: string, url: string, init: FetchProxyInit, sink: FetchProxySink): Promise<FetchProxyHead> {
      const controller = new AbortController()
      inflight.set(key, controller)
      let response: Response
      try {
        response = await fetcher(url, {
          method: init.method,
          headers: init.headers,
          body: init.body,
          signal: controller.signal,
        })
      } catch (error) {
        if (inflight.get(key) === controller) inflight.delete(key)
        throw error
      }
      if (response.body) void pump(key, controller, response.body, sink)
      else {
        inflight.delete(key)
        sink.end()
      }
      return {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
      }
    },
    abort(key: string) {
      inflight.get(key)?.abort()
      inflight.delete(key)
    },
    abortPrefix(prefix: string) {
      for (const [key, controller] of inflight) {
        if (!key.startsWith(prefix)) continue
        controller.abort()
        inflight.delete(key)
      }
    },
    size: () => inflight.size,
  }
}
