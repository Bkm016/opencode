import { afterEach, describe, expect, test } from "bun:test"
import { isSessionPinned, migrateLegacySessionPins, setSessionPinned, type SessionPinUpdate } from "./session-pin"
import { sortedRootSessions } from "@/pages/layout/helpers"
import { type Session } from "@opencode-ai/sdk/v2/client"

const session = (input: Partial<Session> & Pick<Session, "id" | "directory">) =>
  ({
    title: "",
    version: "v2",
    parentID: undefined,
    messageCount: 0,
    permissions: { session: {}, share: {} },
    time: { created: 0, updated: 0, archived: undefined },
    ...input,
  }) as Session

describe("sortedRootSessions with pins", () => {
  test("pinned block precedes recent order, most recently pinned first", () => {
    const now = 1_000_000
    const store = {
      path: { directory: "/workspace" },
      session: [
        session({ id: "old", directory: "/workspace", time: { created: 1, updated: 100, pinned: 20 } }),
        session({ id: "mid", directory: "/workspace", time: { created: 2, updated: 200, pinned: 10 } }),
        session({ id: "new", directory: "/workspace", time: { created: 3, updated: 300 } }),
      ],
    }
    expect(sortedRootSessions(store, now).map((item) => item.id)).toEqual(["old", "mid", "new"])
  })

  test("ignores pinned sessions that are not visible roots", () => {
    const store = {
      path: { directory: "/workspace" },
      session: [
        session({ id: "root", directory: "/workspace", time: { created: 1, updated: 10 } }),
        session({
          id: "child",
          directory: "/workspace",
          parentID: "root",
          time: { created: 2, updated: 20, pinned: 5 },
        }),
      ],
    }
    expect(sortedRootSessions(store, 100).map((item) => item.id)).toEqual(["root"])
  })
})

describe("setSessionPinned", () => {
  test("shows the pin optimistically and sends null to unpin", async () => {
    const item = session({ id: "a", directory: "/workspace" })
    const sent: SessionPinUpdate[] = []
    let resolve!: () => void
    const done = setSessionPinned({
      session: item,
      pinned: true,
      update: (value) => {
        sent.push(value)
        return new Promise((r) => (resolve = () => r({})))
      },
      apply: () => {},
    })
    expect(isSessionPinned(item)).toBe(true)
    resolve()
    await done
    expect(isSessionPinned(item)).toBe(false)
    expect(typeof sent[0]?.time.pinned).toBe("number")

    const pinned = session({ id: "b", directory: "/workspace", time: { created: 0, updated: 0, pinned: 1 } })
    await setSessionPinned({
      session: pinned,
      pinned: false,
      update: async (value) => {
        sent.push(value)
        return {}
      },
      apply: () => {},
    })
    expect(sent[1]?.time.pinned).toBeNull()
  })

  test("rolls back the optimistic pin when the request fails", async () => {
    const item = session({ id: "c", directory: "/workspace" })
    await expect(
      setSessionPinned({
        session: item,
        pinned: true,
        update: () => Promise.reject(new Error("boom")),
        apply: () => {},
      }),
    ).rejects.toThrow("boom")
    expect(isSessionPinned(item)).toBe(false)
  })
})

describe("migrateLegacySessionPins", () => {
  const key = "opencode.session.pinned.v1"
  afterEach(() => localStorage.removeItem(key))

  test("uploads local pins in their order and clears local storage", async () => {
    localStorage.setItem(key, JSON.stringify({ "/workspace": ["first", "second"], "/other": ["x"] }))
    const sent: SessionPinUpdate[] = []
    await migrateLegacySessionPins(async (value) => {
      sent.push(value)
      if (value.sessionID === "x") throw new Error("missing")
    })
    expect(sent.map((item) => item.sessionID)).toEqual(["first", "second", "x"])
    expect(sent[0]!.time.pinned).toBeGreaterThan(sent[1]!.time.pinned)
    expect(localStorage.getItem(key)).toBeNull()
  })
})
