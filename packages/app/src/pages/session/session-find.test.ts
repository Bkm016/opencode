import { describe, expect, test } from "bun:test"
import { collectSessionFindMatches, messageUserAnchor, partSearchText } from "./session-find"
import type { Message, Part } from "@opencode-ai/sdk/v2"

const user = (id: string): Message =>
  ({
    id,
    sessionID: "s",
    role: "user",
    time: { created: 1 },
  }) as Message

const assistant = (id: string, parentID: string): Message =>
  ({
    id,
    sessionID: "s",
    role: "assistant",
    parentID,
    time: { created: 1 },
  }) as Message

const textPart = (id: string, messageID: string, text: string): Part =>
  ({
    id,
    sessionID: "s",
    messageID,
    type: "text",
    text,
  }) as Part

describe("session-find", () => {
  test("partSearchText reads text parts", () => {
    expect(partSearchText(textPart("p1", "m1", "hello"))).toBe("hello")
  })

  test("messageUserAnchor maps assistant to parent", () => {
    expect(messageUserAnchor(user("u1"))).toBe("u1")
    expect(messageUserAnchor(assistant("a1", "u1"))).toBe("u1")
  })

  test("collectSessionFindMatches finds case-insensitive occurrences", () => {
    const messages = [user("u1"), assistant("a1", "u1")]
    const parts: Record<string, Part[]> = {
      u1: [textPart("p1", "u1", "Hello world")],
      a1: [textPart("p2", "a1", "hello again")],
    }
    const matches = collectSessionFindMatches({
      messages,
      parts: (id) => parts[id],
      query: "hello",
    })
    expect(matches).toHaveLength(2)
    expect(matches[0]?.userMessageID).toBe("u1")
    expect(matches[1]?.messageID).toBe("a1")
    expect(matches[1]?.userMessageID).toBe("u1")
  })

  test("collectSessionFindMatches returns empty for blank query", () => {
    expect(
      collectSessionFindMatches({
        messages: [user("u1")],
        parts: () => [textPart("p1", "u1", "x")],
        query: "   ",
      }),
    ).toEqual([])
  })
})
