import {
  createContext,
  createMemo,
  Show,
  useContext,
  type Context,
  type ParentProps,
  type Accessor,
} from "solid-js"

// HMR re-evaluates context modules and would mint a new createContext identity each
// time, so live Providers (old identity) stop matching reloaded use() hooks. Cache
// by name on globalThis so provider/consumer stay on the same Context object.
const registry = (() => {
  const key = "__opencode_simple_context__"
  const root = globalThis as typeof globalThis & { [key]?: Map<string, Context<unknown>> }
  if (!root[key]) root[key] = new Map()
  return root[key]
})()

function contextFor<T>(name: string) {
  const existing = registry.get(name)
  if (existing) return existing as Context<T | undefined>
  const created = createContext<T>()
  registry.set(name, created as Context<unknown>)
  return created
}

export function createSimpleContext<T, Props extends Record<string, any>>(
  input: {
    name: string
    init: ((input: Props) => T) | (() => T)
  } & (T extends { ready: unknown } ? { gate: boolean } : { gate?: boolean }),
) {
  const ctx = contextFor<T>(input.name)

  return {
    provider: (props: ParentProps<Props>) => {
      const init = input.init(props)
      const gate = input.gate ?? true

      if (!gate) {
        return <ctx.Provider value={init}>{props.children}</ctx.Provider>
      }

      // Access init.ready inside the memo to make it reactive for getter properties
      const isReady = createMemo(() => {
        // @ts-expect-error
        const ready = init.ready as Accessor<boolean> | boolean | undefined
        return ready === undefined || (typeof ready === "function" ? ready() : ready)
      })
      return (
        <Show when={isReady()}>
          <ctx.Provider value={init}>{props.children}</ctx.Provider>
        </Show>
      )
    },
    use() {
      const value = useContext(ctx)
      if (!value) throw new Error(`${input.name} context must be used within a context provider`)
      return value
    },
  }
}
