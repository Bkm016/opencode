import { describe, expect, test } from "bun:test"
import { patchFiles, pendingPatchFiles } from "./apply-patch-file"
import { text } from "./session-diff"

describe("apply patch file", () => {
  test("projects growing additions through the same file diff as completed metadata", () => {
    const first = pendingPatchFiles("apply_patch", { patchText: "*** Begin Patch\n*** Add File: a.ts\n+one" })[0]!
    const next = pendingPatchFiles("apply_patch", {
      patchText: "*** Begin Patch\n*** Add File: a.ts\n+one\n+two\n*** End Patch",
    })[0]!
    expect(first.filePath).toBe("a.ts")
    expect(first.additions).toBe(1)
    expect(next.additions).toBe(2)
    expect(text(next.view, "additions")).toContain("one\ntwo")
    expect(text(next.view, "additions")).not.toContain("***")
    const completed = patchFiles([
      { filePath: "a.ts", type: "add", before: "", after: text(next.view, "additions"), additions: 2, deletions: 0 },
    ])[0]!
    expect(next.view.fileDiff).toEqual(completed.view.fileDiff)
  })

  test("projects update snippets without presenting them as whole files", () => {
    const file = pendingPatchFiles("apply_patch", {
      patchText: "*** Begin Patch\n*** Update File: a.ts\n@@\n one\n-two\n+three",
    })[0]!
    expect(file.view.fileDiff.isPartial).toBe(true)
    expect(file.additions).toBe(1)
    expect(file.deletions).toBe(1)
    expect(text(file.view, "deletions")).toContain("one\ntwo")
    expect(text(file.view, "additions")).toContain("one\nthree")
  })

  test("updates multiedit file diffs as new replacement lines arrive", () => {
    const files = pendingPatchFiles("multiedit", {
      edits: [{ filePath: "a.ts", oldString: "before\n", newString: "after\nnext\n" }],
    })
    expect(files[0]!.additions).toBe(2)
    expect(files[0]!.deletions).toBe(1)
    expect(text(files[0]!.view, "additions")).toBe("after\nnext\n")
  })

  test("does not create file cards from unfinished headers", () => {
    expect(pendingPatchFiles("apply_patch", { patchText: "*** Begin Patch\n*** Add File: a" })).toEqual([])
  })

  test("parses patch metadata from the server", () => {
    const file = patchFiles([
      {
        filePath: "/tmp/a.ts",
        relativePath: "a.ts",
        type: "update",
        patch:
          "Index: a.ts\n===================================================================\n--- a.ts\t\n+++ a.ts\t\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n",
        additions: 1,
        deletions: 1,
      },
    ])[0]

    expect(file).toBeDefined()
    expect(file?.view.fileDiff.name).toBe("a.ts")
    expect(file?.view.fileDiff.isPartial).toBe(false)
    expect(text(file!.view, "deletions")).toBe("one\ntwo\n")
    expect(text(file!.view, "additions")).toBe("one\nthree\n")
  })

  test("keeps legacy before and after payloads working", () => {
    const file = patchFiles([
      {
        filePath: "/tmp/a.ts",
        relativePath: "a.ts",
        type: "update",
        before: "one\n",
        after: "two\n",
        additions: 1,
        deletions: 1,
      },
    ])[0]

    expect(file).toBeDefined()
    expect(text(file!.view, "deletions")).toBe("one\n")
    expect(text(file!.view, "additions")).toBe("two\n")
  })
})
