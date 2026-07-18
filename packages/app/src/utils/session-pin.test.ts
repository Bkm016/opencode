import { describe, expect, test } from "bun:test"
import {
  pinListOf,
  withPinnedSession,
  withoutPinnedSession,
  type SessionPinMap,
} from "./session-pin"
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

describe("session pin map", () => {
  test("pins prepend and re-pin moves to front", () => {
    let map: SessionPinMap = {}
    map = withPinnedSession(map, "/workspace", "a")
    map = withPinnedSession(map, "/workspace", "b")
    expect(pinListOf(map, "/workspace")).toEqual(["b", "a"])
    map = withPinnedSession(map, "/workspace", "a")
    expect(pinListOf(map, "/workspace")).toEqual(["a", "b"])
  })

  test("unpins and drops empty directory key", () => {
    let map: SessionPinMap = withPinnedSession({}, "/workspace", "a")
    map = withPinnedSession(map, "/workspace", "b")
    map = withoutPinnedSession(map, "/workspace", "a")
    expect(pinListOf(map, "/workspace")).toEqual(["b"])
    map = withoutPinnedSession(map, "/workspace", "b")
    expect(pinListOf(map, "/workspace")).toEqual([])
    expect(map["/workspace"]).toBeUndefined()
  })

  test("scopes pins by pathKey directory", () => {
    let map: SessionPinMap = withPinnedSession({}, "C:\\tmp\\app", "x")
    expect(pinListOf(map, "C:/tmp/app")).toEqual(["x"])
    expect(pinListOf(map, "/other")).toEqual([])
  })
})

describe("sortedRootSessions with pins", () => {
  test("pinned block precedes recent order and keeps pin order", () => {
    const now = 1_000_000
    const store = {
      path: { directory: "/workspace" },
      session: [
        session({ id: "old", directory: "/workspace", time: { created: 1, updated: 100 } }),
        session({ id: "mid", directory: "/workspace", time: { created: 2, updated: 200 } }),
        session({ id: "new", directory: "/workspace", time: { created: 3, updated: 300 } }),
      ],
    }
    expect(sortedRootSessions(store, now).map((item) => item.id)).toEqual(["new", "mid", "old"])
    expect(sortedRootSessions(store, now, ["old", "mid"]).map((item) => item.id)).toEqual([
      "old",
      "mid",
      "new",
    ])
  })

  test("ignores pin ids that are not visible roots", () => {
    const store = {
      path: { directory: "/workspace" },
      session: [
        session({ id: "root", directory: "/workspace", time: { created: 1, updated: 10 } }),
        session({ id: "child", directory: "/workspace", parentID: "root", time: { created: 2, updated: 20 } }),
      ],
    }
    expect(sortedRootSessions(store, 100, ["child", "missing", "root"]).map((item) => item.id)).toEqual(["root"])
  })
})
