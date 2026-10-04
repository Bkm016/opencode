import { describe, expect, test } from "bun:test"
import { DEFAULT_RENDER_RANGE, DiffHunksRenderer } from "@pierre/diffs"
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

  test.each(["unified", "split"] as const)("renders highlighted late update snippets in %s mode", async (diffStyle) => {
    const context = Array.from({ length: 12 }, (_, index) => ` keep${index}`).join("\n")
    const file = pendingPatchFiles("apply_patch", {
      patchText: `*** Begin Patch\n*** Update File: AcceptanceAgent.java\n@@\n${context}\n-oldValue\n+newValue\n*** End Patch`,
    })[0]!
    const renderer = new DiffHunksRenderer({ theme: "github-dark", diffStyle })
    try {
      const html = renderer.renderFullHTML(await renderer.asyncRender(file.view.fileDiff))
      expect(file.view.fileDiff.isPartial).toBe(true)
      expect(html).toContain("keep0")
      expect(html).toContain("keep11")
      expect(html).toContain("oldValue")
      expect(html).toContain("newValue")
    } finally {
      renderer.cleanUp()
    }
  })

  test.each(["unified", "split"] as const)(
    "renders highlighted separated multiedit changes in %s mode",
    async (diffStyle) => {
      const context = Array.from({ length: 16 }, (_, index) => `middle${index}\n`).join("")
      const file = pendingPatchFiles("multiedit", {
        edits: [
          { filePath: "a.ts", oldString: `oldFirst\n${context}oldLast`, newString: `newFirst\n${context}newLast` },
        ],
      })[0]!
      const renderer = new DiffHunksRenderer({ theme: "github-dark", diffStyle })
      try {
        const html = renderer.renderFullHTML(await renderer.asyncRender(file.view.fileDiff))
        expect(text(file.view, "deletions")).toBe(`oldFirst\n${context}oldLast`)
        expect(text(file.view, "additions")).toBe(`newFirst\n${context}newLast`)
        expect(html).toContain("middle8")
        expect(html).toContain("oldFirst")
        expect(html).toContain("newFirst")
        expect(html).toContain("oldLast")
        expect(html).toContain("newLast")
        const window = renderer.renderFullHTML(
          await renderer.asyncRender(file.view.fileDiff, { ...DEFAULT_RENDER_RANGE, startingLine: 12, totalLines: 8 }),
        )
        expect(window).not.toContain("oldFirst")
        expect(window).not.toContain("newFirst")
        expect(window).toContain("oldLast")
        expect(window).toContain("newLast")
      } finally {
        renderer.cleanUp()
      }
    },
  )

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
