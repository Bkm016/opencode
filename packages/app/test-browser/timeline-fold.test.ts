import { describe, expect, mock, test } from "bun:test"
import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2"

// `?worker&url` 只有 Vite 能解析；行构建不需要高亮 worker。
mock.module("../../session-ui/src/components/markdown-shiki.worker.ts?worker&url", () => ({ default: "" }))
mock.module("@pierre/diffs/worker/worker.js?worker&url", () => ({ default: "" }))
const { Timeline, TimelineRow } = await import("../src/pages/session/timeline/rows")

const user = { id: "m1", sessionID: "s", role: "user", time: { created: 1 } } as UserMessage
const assistant = (id: string) =>
  ({ id, sessionID: "s", role: "assistant", parentID: "m1", time: { created: 2, completed: 3 } }) as AssistantMessage
const read = (messageID: string) =>
  ({
    id: `${messageID}-p`,
    messageID,
    sessionID: "s",
    type: "tool",
    tool: "read",
    callID: `${messageID}-c`,
    state: {
      status: "completed",
      input: { filePath: "a.ts" },
      output: "",
      title: "",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  }) as Part
const text = (messageID: string) =>
  ({ id: `${messageID}-p`, messageID, sessionID: "s", type: "text", text: "done" }) as Part

// m2、m3 读文件后在 m4 处折叠，m5 继续读，m6 给出最终回答。
const parts: Record<string, Part[]> = { m2: [read("m2")], m3: [read("m3")], m5: [read("m5")], m6: [text("m6")] }
const assistants = ["m2", "m3", "m5", "m6"].map(assistant)
const build = (status: "busy" | "idle") =>
  Timeline.constructMessageRows(user, (id) => parts[id] ?? [], assistants, 0, false, status, status === "busy", ["m4"])

describe("constructMessageRows folds", () => {
  test("streaming turn shows the fold divider between the steps it split", () => {
    const rows = build("busy")
    const tags = rows.map((row) => (row._tag === "TurnDivider" ? `divider:${row.id}` : row._tag))
    expect(tags).toEqual(["UserMessage", "AssistantPart", "divider:m4", "AssistantPart", "AssistantPart", "Thinking"])
  })

  test("completed turn keeps the fold inside the process summary", () => {
    const rows = build("idle")
    expect(rows.map((row) => row._tag)).toEqual(["UserMessage", "ProcessSummary", "AssistantPart"])
    const summary = rows[1] as TimelineRow.ProcessSummary
    expect(summary.groups).toHaveLength(2)
    expect(summary.folds).toEqual([summary.groups[1]!.key])
  })

  test("fold after the last step stays visible at the end", () => {
    const rows = Timeline.constructMessageRows(
      user,
      (id) => parts[id] ?? [],
      assistants.slice(0, 2),
      0,
      false,
      "busy",
      true,
      ["m4"],
    )
    expect(rows.filter((row) => row._tag === "TurnDivider").map((row) => TimelineRow.key(row))).toEqual([
      "turn-divider:m1:compaction:m4",
    ])
  })
})
