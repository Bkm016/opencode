import { describe, expect, test } from "bun:test"
import type { ServerConnection } from "@/context/server"
import {
  readSessionNotFoundDetail,
  readSessionTabsRemovedDetail,
  SESSION_NOT_FOUND_EVENT,
  SESSION_TABS_REMOVED_EVENT,
} from "./titlebar-session-events"

const remote = "remote" as ServerConnection.Key

describe("titlebar session events", () => {
  test("reads valid removed session tab details", () => {
    expect(
      readSessionTabsRemovedDetail(
        new CustomEvent(SESSION_TABS_REMOVED_EVENT, {
          detail: { server: "remote", directory: "/tmp/project", sessionIDs: ["ses_1", "ses_2", 1] },
        }),
      ),
    ).toEqual({
      server: remote,
      directory: "/tmp/project",
      sessionIDs: ["ses_1", "ses_2"],
    })
  })

  test("ignores invalid removed session tab details", () => {
    expect(readSessionTabsRemovedDetail(new Event(SESSION_TABS_REMOVED_EVENT))).toBeUndefined()
    expect(
      readSessionTabsRemovedDetail(
        new CustomEvent(SESSION_TABS_REMOVED_EVENT, {
          detail: { directory: "/tmp/project", sessionIDs: [] },
        }),
      ),
    ).toBeUndefined()
  })

  test("reads valid session not found details", () => {
    expect(
      readSessionNotFoundDetail(
        new CustomEvent(SESSION_NOT_FOUND_EVENT, {
          detail: { server: "remote", sessionID: "ses_missing" },
        }),
      ),
    ).toEqual({
      server: remote,
      sessionID: "ses_missing",
    })
  })

  test("ignores invalid session not found details", () => {
    expect(readSessionNotFoundDetail(new Event(SESSION_NOT_FOUND_EVENT))).toBeUndefined()
    expect(
      readSessionNotFoundDetail(
        new CustomEvent(SESSION_NOT_FOUND_EVENT, {
          detail: { sessionID: 1 },
        }),
      ),
    ).toBeUndefined()
  })
})
