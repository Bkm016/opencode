import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import type { Message, UserMessage } from "@opencode-ai/sdk/v2"
import { createRoot, createSignal } from "solid-js"

const syncCalls: Array<{ id: string; force?: boolean }> = []
const syncByID = new Map<string, Promise<void>>()
const freshByID = new Map<string, boolean>()
const messageByID: Record<string, Message[] | undefined> = {}
const loadingByID = new Map<string, boolean>()
const moreByID = new Map<string, boolean>()

mock.module("@/context/sync", () => ({
  useSync: () => () => ({
    data: {
      message: messageByID,
    },
    session: {
      sync: async (id: string, options?: { force?: boolean }) => {
        syncCalls.push({ id, force: options?.force })
        await syncByID.get(id)
      },
      history: {
        loading: (id: string) => loadingByID.get(id) ?? false,
        more: (id: string) => moreByID.get(id) ?? false,
        loadMore: async () => undefined,
      },
    },
  }),
}))

mock.module("@/context/server-sync", () => ({
  useServerSync: () => () => ({
    session: {
      fresh: (id: string) => freshByID.get(id) ?? true,
      history: {
        loading: (id: string) => loadingByID.get(id) ?? false,
      },
    },
  }),
}))

const { createTimelineModel } = await import("@/pages/session/timeline/model")

const user = (id: string) => ({ id, role: "user" }) as UserMessage

function resetFixtures() {
  syncCalls.length = 0
  syncByID.clear()
  freshByID.clear()
  for (const key of Object.keys(messageByID)) delete messageByID[key]
  loadingByID.clear()
  moreByID.clear()
}

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(resetFixtures)
afterEach(resetFixtures)

describe("createTimelineModel", () => {
  test("keeps the model responsive while cold session sync is pending", async () => {
    syncByID.set("ses_a", new Promise(() => {}))
    messageByID.ses_b = [user("msg_b")]

    await createRoot(async (dispose) => {
      const [sessionID, setSessionID] = createSignal<string | undefined>("ses_a")
      const model = createTimelineModel({
        sessionID,
        revertMessageID: () => undefined,
      })

      await flush()
      expect(syncCalls.map((call) => call.id)).toEqual(["ses_a"])
      expect(model.messages()).toEqual([])
      expect(model.ready()).toBe(false)

      setSessionID("ses_b")
      await flush()
      expect(syncCalls.map((call) => call.id)).toEqual(["ses_a", "ses_b"])
      expect(model.messages().map((message) => message.id)).toEqual(["msg_b"])
      expect(model.userMessages().map((message) => message.id)).toEqual(["msg_b"])

      dispose()
    })
  })
})
