import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { QueryBatch } from "../../src/session/query-batch"

function tool(name: string, input: Record<string, unknown>) {
  return { type: "tool", tool: name, state: { status: "completed", input } }
}

function assistant(...parts: unknown[]) {
  return { info: { role: "assistant" }, parts } as unknown as SessionV1.WithParts
}

const user = { info: { role: "user" }, parts: [] } as unknown as SessionV1.WithParts
const grep = (command: string) => assistant(tool("bash", { command }))

describe("session.query-batch", () => {
  test("classifies read-only shell commands", () => {
    expect(QueryBatch.isReadOnlyCommand("grep -rn anyio tests/ | head")).toBe(true)
    expect(QueryBatch.isReadOnlyCommand("sed -n 1,60p a.py && cat b.py 2>/dev/null")).toBe(true)
    expect(QueryBatch.isReadOnlyCommand("git log --oneline -3")).toBe(true)
    expect(QueryBatch.isReadOnlyCommand("cd src && ls")).toBe(true)
    expect(QueryBatch.isReadOnlyCommand('grep -n "iter_raw\\|aiter_raw" tests/a.py | head -40')).toBe(true)
    expect(QueryBatch.isReadOnlyCommand("grep -c '>' a.py")).toBe(true)
    expect(QueryBatch.isReadOnlyCommand("cat > a.py << 'EOF'")).toBe(false)
    expect(QueryBatch.isReadOnlyCommand("sed -i s/a/b/ a.py")).toBe(false)
    expect(QueryBatch.isReadOnlyCommand("python -m pytest -q")).toBe(false)
    expect(QueryBatch.isReadOnlyCommand("git stash && pytest")).toBe(false)
  })

  test("counts trailing steps with exactly one read-only query", () => {
    const messages = [user, grep("ls"), assistant(tool("read", {}), tool("grep", {})), grep("grep a x"), grep("grep b x")]
    expect(QueryBatch.singleQueryStreak(messages)).toBe(2)
    expect(QueryBatch.singleQueryStreak([user, grep("grep a x"), assistant(tool("edit", {}))])).toBe(0)
    expect(QueryBatch.singleQueryStreak([grep("grep a x"), user, grep("grep b x")])).toBe(1)
  })

  test("reminds on every third consecutive single-query step", () => {
    const steps = (n: number) => [user, ...Array.from({ length: n }, (_, i) => grep(`grep ${i} x`))]
    expect(QueryBatch.shouldRemind(steps(2))).toBe(false)
    expect(QueryBatch.shouldRemind(steps(3))).toBe(true)
    expect(QueryBatch.shouldRemind(steps(4))).toBe(false)
    expect(QueryBatch.shouldRemind(steps(6))).toBe(true)
  })

  test("background shell jobs are not queries", () => {
    const background = assistant(tool("bash", { command: "tail -f log", background: true }))
    expect(QueryBatch.singleQueryStreak([user, grep("ls"), background])).toBe(0)
  })
})
