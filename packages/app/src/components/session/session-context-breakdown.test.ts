import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { estimateSessionContextBreakdown } from "./session-context-breakdown"

const user = (id: string) => {
  return {
    id,
    role: "user",
    time: { created: 1 },
  } as unknown as Message
}

const assistant = (id: string) => {
  return {
    id,
    role: "assistant",
    time: { created: 1 },
  } as unknown as Message
}

describe("estimateSessionContextBreakdown", () => {
  test("estimates tokens and keeps remaining tokens as other", () => {
    const messages = [user("u1"), assistant("a1")]
    const parts = {
      u1: [{ type: "text", text: "hello world" }] as unknown as Part[],
      a1: [{ type: "text", text: "assistant response" }] as unknown as Part[],
    }

    const output = estimateSessionContextBreakdown({
      messages,
      parts,
      input: 20,
      systemPrompt: "system prompt",
    })

    const map = Object.fromEntries(output.segments.map((segment) => [segment.key, segment.tokens]))
    expect(map.system).toBe(4)
    expect(map.user).toBe(3)
    expect(map.assistant).toBe(5)
    expect(map.other).toBe(8)

    const userSeg = output.segments.find((segment) => segment.key === "user")
    expect(userSeg?.details).toEqual(
      expect.arrayContaining([
        { kind: "text", tokens: 3 },
        { kind: "messages", count: 1 },
        { kind: "parts", count: 1 },
      ]),
    )

    const userRow = output.prompts.find((row) => row.kind === "user" && row.tokens === 3)
    expect(userRow).toBeTruthy()
    expect(userRow?.facts.some((fact) => fact.kind === "preview" && fact.text.includes("hello"))).toBeTrue()
    expect(output.prompts.some((row) => row.kind === "system")).toBeTrue()
  })

  test("scales segments when estimates exceed input", () => {
    const messages = [user("u1"), assistant("a1")]
    const parts = {
      u1: [{ type: "text", text: "x".repeat(400) }] as unknown as Part[],
      a1: [{ type: "text", text: "y".repeat(400) }] as unknown as Part[],
    }

    const output = estimateSessionContextBreakdown({
      messages,
      parts,
      input: 10,
      systemPrompt: "z".repeat(200),
    })

    const total = output.segments.reduce((sum, segment) => sum + segment.tokens, 0)
    expect(total).toBeLessThanOrEqual(10)
    expect(output.segments.every((segment) => segment.width <= 100)).toBeTrue()
  })

  test("exposes tool ranking and reasoning details", () => {
    const messages = [assistant("a1")]
    const parts = {
      a1: [
        { type: "reasoning", text: "think".repeat(20) },
        { type: "text", text: "done" },
        {
          type: "tool",
          tool: "read",
          state: { status: "completed", input: { path: "a" }, output: "x".repeat(80) },
        },
        {
          type: "tool",
          tool: "bash",
          state: { status: "completed", input: { command: "ls" }, output: "y".repeat(40) },
        },
        {
          type: "tool",
          tool: "read",
          state: { status: "completed", input: { path: "b" }, output: "z".repeat(40) },
        },
      ] as unknown as Part[],
    }

    const output = estimateSessionContextBreakdown({
      messages,
      parts,
      input: 200,
    })

    const assistantSeg = output.segments.find((segment) => segment.key === "assistant")
    const toolSeg = output.segments.find((segment) => segment.key === "tool")
    expect(assistantSeg?.details.some((item) => item.kind === "reasoning")).toBeTrue()
    expect(toolSeg?.details.filter((item) => item.kind === "tool").map((item) => item.kind === "tool" && item.name)).toEqual([
      "read",
      "bash",
    ])
    expect(output.tools.map((row) => row.name)).toEqual(["read", "bash"])
    expect(output.tools[0]?.count).toBe(2)
    expect(output.tools[0]?.facts.some((fact) => fact.kind === "output")).toBeTrue()
    expect(output.tools[0]?.facts.some((fact) => fact.kind === "preview")).toBeTrue()
    expect(output.prompts.some((row) => row.kind === "reasoning")).toBeTrue()
    const reasoning = output.prompts.find((row) => row.kind === "reasoning")
    expect(reasoning?.facts.some((fact) => fact.kind === "parts")).toBeTrue()
    expect(reasoning?.facts.some((fact) => fact.kind === "preview")).toBeTrue()
  })

  test("tolerates null tool input without throwing", () => {
    const messages = [assistant("a1")]
    const parts = {
      a1: [
        {
          type: "tool",
          tool: "read",
          state: { status: "pending", input: null, raw: "partial" },
        },
        {
          type: "tool",
          tool: "bash",
          state: { status: "running", input: undefined },
        },
      ] as unknown as Part[],
    }

    const output = estimateSessionContextBreakdown({
      messages,
      parts,
      input: 50,
    })

    expect(output.segments.length).toBeGreaterThan(0)
    expect(output.tools.some((row) => row.name === "read")).toBeTrue()
  })

  test("splits system prompt into labeled sections and separates synthetic user text", () => {
    const systemPrompt = [
      "You are a coding agent.",
      "Here is some useful information about the environment you are running in:\n<env>\n  Working directory: /tmp\n</env>",
      "Today's date: Sun Jul 19 2026",
      "Instructions from: AGENTS.md\n- be concise",
    ].join("\n\n")

    const messages = [user("u1")]
    const parts = {
      u1: [
        { type: "text", text: "real user" },
        { type: "text", text: "injected skill", synthetic: true },
      ] as unknown as Part[],
    }

    const output = estimateSessionContextBreakdown({
      messages,
      parts,
      input: 500,
      systemPrompt,
    })

    const systemNames = output.prompts.filter((row) => row.kind === "system").map((row) => row.name)
    expect(systemNames).toEqual(expect.arrayContaining(["section-1", "core/environment", "core/date", "instructions"]))
    expect(output.prompts.some((row) => row.kind === "user")).toBeTrue()
    expect(output.prompts.some((row) => row.kind === "synthetic")).toBeTrue()
  })
})
