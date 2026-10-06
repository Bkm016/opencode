import { describe, expect, test } from "bun:test"
import type { Prompt } from "@/context/prompt"
import { promptText, rebuildPrompt } from "./enhance"

const file = { type: "file" as const, path: "src/Button.tsx", content: "@src/Button.tsx", start: 3, end: 18 }
const agent = { type: "agent" as const, name: "plan", content: "@plan", start: 19, end: 24 }
const image = { type: "image" as const, id: "img_1", filename: "a.png", mime: "image/png", dataUrl: "data:," }

describe("promptText", () => {
  test("joins inline parts and skips images", () => {
    const prompt: Prompt = [{ type: "text", content: "看下 ", start: 0, end: 3 }, file, image]
    expect(promptText(prompt)).toBe("看下 @src/Button.tsx")
  })
})

describe("rebuildPrompt", () => {
  test("keeps references that still appear in the rewrite", () => {
    const original: Prompt = [{ type: "text", content: "看下 ", start: 0, end: 3 }, file, agent, image]
    const result = rebuildPrompt("让 @plan 检查 @src/Button.tsx 的 hover", original)
    expect(result).toEqual([
      { type: "text", content: "让 ", start: 0, end: 2 },
      { ...agent, start: 2, end: 7 },
      { type: "text", content: " 检查 ", start: 7, end: 11 },
      { ...file, start: 11, end: 26 },
      { type: "text", content: " 的 hover", start: 26, end: 34 },
      image,
    ])
  })

  test("drops references the rewrite no longer contains", () => {
    const result = rebuildPrompt("检查按钮", [file])
    expect(result).toEqual([{ type: "text", content: "检查按钮", start: 0, end: 4 }])
  })

  test("does not place a shorter reference inside a longer one", () => {
    const short = { type: "file" as const, path: "src/B.ts", content: "@src/B.ts", start: 0, end: 9 }
    const long = { type: "file" as const, path: "src/B.tsx", content: "@src/B.tsx", start: 10, end: 20 }
    const result = rebuildPrompt("@src/B.tsx 和 @src/B.ts", [short, long])
    expect(result.map((part) => part.type === "file" && part.path)).toEqual(["src/B.tsx", false, "src/B.ts"])
  })

  test("returns an empty text part for empty output", () => {
    expect(rebuildPrompt("", [])).toEqual([{ type: "text", content: "", start: 0, end: 0 }])
  })
})
