import { expect, test } from "bun:test"
import { Suspense, createComponent, createSignal, startTransition } from "solid-js"
import { render } from "solid-js/web"

const settleWithin = <T,>(promise: Promise<T>) =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("transition timed out")), 100))])

test("a failed transition does not block later transitions", async () => {
  const root = document.createElement("div")
  const dispose = render(() => createComponent(Suspense, { fallback: null, children: "ready" }), root)
  const [value, setValue] = createSignal(0)

  try {
    await expect(
      startTransition(() => {
        setValue(99)
        throw new Error("transition failed")
      }),
    ).rejects.toThrow("transition failed")
    expect(value()).toBe(0)

    await settleWithin(startTransition(() => setValue(1)))
    expect(value()).toBe(1)
  } finally {
    dispose()
  }
})
