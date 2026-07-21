import { describe, expect, test } from "bun:test"
import { createSignal, Show, type ParentProps } from "solid-js"
import { render } from "solid-js/web"
import { MemoryRouter, Route, createMemoryHistory, useNavigate } from "@solidjs/router"

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("solid-router Routes disposal (#451)", () => {
  test("route roots are disposed when a root Show gate unmounts Routes", async () => {
    const history = createMemoryHistory()
    history.set({ value: "/a/b" })
    const [show, setShow] = createSignal(true)
    let nav!: ReturnType<typeof useNavigate>
    const errors: unknown[] = []
    const onError = (event: ErrorEvent) => {
      errors.push(event.error ?? event.message)
    }
    const onRejection = (event: PromiseRejectionEvent) => {
      errors.push(event.reason)
    }
    window.addEventListener("error", onError)
    window.addEventListener("unhandledrejection", onRejection)

    const Layout = (props: ParentProps) => {
      nav = useNavigate()
      return <div>layout{props.children}</div>
    }

    const root = document.createElement("div")
    const dispose = render(
      () => (
        <MemoryRouter history={history} root={(props) => <Show when={show()}>{props.children}</Show>}>
          <Route path="/a" component={Layout}>
            <Route path="/b" component={() => <span>b</span>} />
          </Route>
          <Route path="/login" component={() => <span>login</span>} />
        </MemoryRouter>
      ),
      root,
    )

    try {
      await wait(10)
      expect(root.innerHTML).toContain("b")

      // 隐藏路由树会卸载 Routes；未清理的 detached root 会在下次导航读取失效的 match。
      setShow(false)
      await wait(10)
      expect(root.innerHTML).not.toContain("b")

      nav("/nowhere", { scroll: false })
      await wait(50)

      expect(errors).toEqual([])
    } finally {
      dispose()
      window.removeEventListener("error", onError)
      window.removeEventListener("unhandledrejection", onRejection)
    }
  })
})
