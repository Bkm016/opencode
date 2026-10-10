import { describe, expect, test } from "bun:test"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { computeToolGroupDuration } from "./message-part-groups"

const part = (start: number, end?: number) =>
  ({
    type: "tool",
    tool: "bash",
    state:
      end === undefined
        ? { status: "running", input: {}, time: { start } }
        : { status: "completed", input: {}, output: "", title: "", metadata: {}, time: { start, end } },
  }) as unknown as ToolPart

describe("computeToolGroupDuration", () => {
  test("顺序执行的调用累加", () => {
    expect(computeToolGroupDuration([part(0, 3000), part(4000, 6000)])).toBe("5.00s")
  })

  test("并行执行的调用按并集计，不重复累加", () => {
    expect(computeToolGroupDuration([part(0, 2000), part(10, 2010), part(20, 2020)])).toBe("2.02s")
  })

  test("部分重叠与包含", () => {
    expect(computeToolGroupDuration([part(0, 5000), part(1000, 2000), part(4000, 7000)])).toBe("7.00s")
  })

  test("运行中的调用不计入", () => {
    expect(computeToolGroupDuration([part(0)])).toBeUndefined()
    expect(computeToolGroupDuration([part(0, 800), part(100)])).toBe("800ms")
  })
})
