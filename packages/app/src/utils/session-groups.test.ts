import { describe, expect, test } from "bun:test"
import { groupOpenOf, withSessionGroup, type SessionGroupMap } from "./session-groups"

describe("session group map", () => {
  test("remembers open state per scope and key", () => {
    let map: SessionGroupMap = {}
    map = withSessionGroup(map, "scope-a", "older", false)
    map = withSessionGroup(map, "scope-a", "pinned", true)
    expect(groupOpenOf(map, "scope-a", "older")).toBe(false)
    expect(groupOpenOf(map, "scope-a", "pinned")).toBe(true)
    expect(groupOpenOf(map, "scope-a", "missing")).toBeUndefined()
  })

  test("scopes group state by sidebar list", () => {
    let map: SessionGroupMap = {}
    map = withSessionGroup(map, "scope-a", "older", true)
    map = withSessionGroup(map, "scope-b", "older", false)
    expect(groupOpenOf(map, "scope-a", "older")).toBe(true)
    expect(groupOpenOf(map, "scope-b", "older")).toBe(false)
  })

  test("latest write wins", () => {
    let map: SessionGroupMap = {}
    map = withSessionGroup(map, "scope-a", "older", true)
    map = withSessionGroup(map, "scope-a", "older", false)
    expect(groupOpenOf(map, "scope-a", "older")).toBe(false)
  })
})
