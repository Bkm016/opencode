import { describe, expect, test } from "bun:test"
import {
  planSessionCleanup,
  SESSION_RETENTION_DAYS,
  type SessionCleanupRow,
} from "../../src/server/routes/instance/httpapi/handlers/storage-session-cleanup"

const day = 24 * 60 * 60 * 1000
const now = 1_700_000_000_000
const cutoff = now - SESSION_RETENTION_DAYS * day
const old = cutoff - day
const recent = cutoff + day

function row(partial: Partial<SessionCleanupRow> & Pick<SessionCleanupRow, "id" | "project_id">): SessionCleanupRow {
  return {
    parent_id: null,
    time_updated: recent,
    time_archived: null,
    ...partial,
  }
}

describe("planSessionCleanup", () => {
  test("deletes old sessions from unopened projects", () => {
    const plan = planSessionCleanup({
      cutoff,
      openProjectIDs: new Set(["open"]),
      rows: [
        row({ id: "old-closed", project_id: "closed", time_updated: old }),
        row({ id: "recent-closed", project_id: "closed", time_updated: recent }),
      ],
    })
    expect(plan.unloadedProjects).toBe("available")
    expect(plan.roots).toEqual(["old-closed"])
    expect(plan.removableIDs).toEqual(["old-closed"])
    expect(plan.candidates).toBe(1)
    expect(plan.blocked).toBe(0)
  })

  test("keeps sessions for currently open projects", () => {
    const plan = planSessionCleanup({
      cutoff,
      openProjectIDs: new Set(["open"]),
      rows: [row({ id: "old-open", project_id: "open", time_updated: old })],
    })
    expect(plan.roots).toEqual([])
    expect(plan.removableIDs).toEqual([])
    expect(plan.candidates).toBe(0)
  })

  test("deletes old archived sessions even when project is open", () => {
    const plan = planSessionCleanup({
      cutoff,
      openProjectIDs: new Set(["open"]),
      rows: [
        row({
          id: "old-archived-open",
          project_id: "open",
          time_updated: recent,
          time_archived: old,
        }),
      ],
    })
    expect(plan.roots).toEqual(["old-archived-open"])
    expect(plan.removableIDs).toEqual(["old-archived-open"])
  })

  test("keeps recently archived sessions", () => {
    const plan = planSessionCleanup({
      cutoff,
      openProjectIDs: new Set(["open"]),
      rows: [
        row({
          id: "recent-archived",
          project_id: "closed",
          time_updated: recent,
          time_archived: recent,
        }),
      ],
    })
    expect(plan.roots).toEqual([])
    expect(plan.candidates).toBe(0)
  })

  test("does not remove candidate parent when a non-candidate child must stay", () => {
    const plan = planSessionCleanup({
      cutoff,
      openProjectIDs: new Set(["open"]),
      rows: [
        row({ id: "parent", project_id: "closed", time_updated: old }),
        row({ id: "child-keep", project_id: "open", parent_id: "parent", time_updated: old }),
        row({ id: "child-gone", project_id: "closed", parent_id: "parent", time_updated: old }),
      ],
    })
    expect(plan.candidates).toBe(2)
    expect(plan.blocked).toBe(1)
    expect(plan.roots).toEqual(["child-gone"])
    expect(plan.removableIDs).toEqual(["child-gone"])
  })

  test("skips rule A when open project set is empty; rule B still applies", () => {
    const plan = planSessionCleanup({
      cutoff,
      openProjectIDs: new Set(),
      rows: [
        row({ id: "old-unloaded", project_id: "any", time_updated: old }),
        row({
          id: "old-archived",
          project_id: "any",
          time_updated: recent,
          time_archived: old,
        }),
      ],
    })
    expect(plan.unloadedProjects).toBe("unavailable")
    expect(plan.roots).toEqual(["old-archived"])
    expect(plan.removableIDs).toEqual(["old-archived"])
    expect(plan.candidates).toBe(1)
  })

  test("uses only top-level roots when entire subtree is removable", () => {
    const plan = planSessionCleanup({
      cutoff,
      openProjectIDs: new Set(["open"]),
      rows: [
        row({ id: "root", project_id: "closed", time_updated: old }),
        row({ id: "child", project_id: "closed", parent_id: "root", time_updated: old }),
        row({ id: "grand", project_id: "closed", parent_id: "child", time_updated: old }),
      ],
    })
    expect(plan.roots).toEqual(["root"])
    expect(plan.removableIDs.sort()).toEqual(["child", "grand", "root"])
    expect(plan.blocked).toBe(0)
  })

  test("never deletes sessions in a parent cycle", () => {
    const plan = planSessionCleanup({
      cutoff,
      openProjectIDs: new Set(["open"]),
      rows: [
        row({ id: "a", project_id: "closed", parent_id: "b", time_updated: old }),
        row({ id: "b", project_id: "closed", parent_id: "a", time_updated: old }),
      ],
    })
    expect(plan.candidates).toBe(2)
    expect(plan.roots).toEqual([])
    expect(plan.removableIDs).toEqual([])
    expect(plan.blocked).toBe(2)
  })
})
