import { describe, expect, test } from "bun:test"
import { Patch } from "@opencode-ai/core/patch"

describe("Patch", () => {
  test("parses add, update, and delete hunks", () => {
    expect(
      Patch.parse(
        "*** Begin Patch\n*** Add File: add.txt\n+added\n*** Update File: update.txt\n@@ section\n-old\n+new\n*** Delete File: delete.txt\n*** End Patch",
      ),
    ).toEqual([
      { type: "add", path: "add.txt", contents: "added" },
      {
        type: "update",
        path: "update.txt",
        chunks: [{ oldLines: ["old"], newLines: ["new"], changeContext: "section", endOfFile: undefined }],
        movePath: undefined,
      },
      { type: "delete", path: "delete.txt" },
    ])
  })

  test("strips a heredoc wrapper", () => {
    expect(Patch.parse("cat <<'EOF'\n*** Begin Patch\n*** Add File: add.txt\n+added\n*** End Patch\nEOF")).toEqual([
      { type: "add", path: "add.txt", contents: "added" },
    ])
  })

  test("derives fuzzy line updates while preserving BOM", () => {
    const update = Patch.derive("update.txt", [{ oldLines: ["  old   "], newLines: ["new"] }], "\uFEFFold\n")
    expect(update).toEqual({ content: "new\n", bom: true })
    expect(Patch.joinBom(update.content, update.bom)).toBe("\uFEFFnew\n")
  })

  test("matches EOF-anchored chunks from the end", () => {
    expect(
      Patch.derive(
        "update.txt",
        [{ oldLines: ["marker", "end"], newLines: ["marker changed", "end"], endOfFile: true }],
        "marker\nmiddle\nmarker\nend\n",
      ).content,
    ).toBe("marker\nmiddle\nmarker changed\nend\n")
  })

  test("parses the EOF marker inside update chunks", () => {
    expect(
      Patch.parse("*** Begin Patch\n*** Update File: update.txt\n@@\n-last\n+end\n*** End of File\n*** End Patch"),
    ).toEqual([
      {
        type: "update",
        path: "update.txt",
        movePath: undefined,
        chunks: [{ oldLines: ["last"], newLines: ["end"], changeContext: undefined, endOfFile: true }],
      },
    ])
  })

  test("rejects malformed hunk bodies", () => {
    expect(() => Patch.parse("*** Begin Patch\n*** Add File: add.txt\nmissing plus\n*** End Patch")).toThrow(
      "Invalid add file line",
    )
    expect(() => Patch.parse("*** Begin Patch\n*** Update File: update.txt\n*** End Patch")).toThrow(
      "expected at least one @@ chunk",
    )
    expect(() => Patch.parse("*** Begin Patch\n*** Delete File: delete.txt\nunexpected body\n*** End Patch")).toThrow(
      "Invalid patch line",
    )
  })

  test("partial parse succeeds without End Patch marker", () => {
    expect(Patch.parse("*** Begin Patch\n*** Add File: add.txt\n+added", { partial: true })).toEqual([
      { type: "add", path: "add.txt", contents: "added" },
    ])
  })

  test("partial parse supports growing new lines and preserves trailing whitespace", () => {
    expect(Patch.parse("*** Begin Patch\n*** Add File: add.txt\n+hel", { partial: true })).toEqual([
      { type: "add", path: "add.txt", contents: "hel" },
    ])
    expect(Patch.parse("*** Begin Patch\n*** Add File: add.txt\n+hello", { partial: true })).toEqual([
      { type: "add", path: "add.txt", contents: "hello" },
    ])
    expect(Patch.parse("*** Begin Patch\n*** Add File: add.txt\n+hello world   ", { partial: true })).toEqual([
      { type: "add", path: "add.txt", contents: "hello world   " },
    ])
  })

  test("partial parse ignores incomplete file path headers without trailing newline", () => {
    expect(Patch.parse("*** Begin Patch\n*** Add File: add.txt", { partial: true })).toEqual([])
    expect(Patch.parse("*** Begin Patch\n*** Delete File: del.txt", { partial: true })).toEqual([])
    expect(Patch.parse("*** Begin Patch\n*** Update File: upd.txt", { partial: true })).toEqual([])
    expect(Patch.parse("*** Begin Patch\n*** Add File: add.txt\n", { partial: true })).toEqual([
      { type: "add", path: "add.txt", contents: "" },
    ])
    expect(Patch.parse("*** Begin Patch\n*** Delete File: del.txt\n", { partial: true })).toEqual([
      { type: "delete", path: "del.txt" },
    ])
  })

  test("partial parse preserves earlier files when subsequent file header is incomplete", () => {
    const base = "*** Begin Patch\n*** Add File: file1.txt\n+first file\n"
    expect(Patch.parse(base + "*", { partial: true })).toEqual([
      { type: "add", path: "file1.txt", contents: "first file" },
    ])
    expect(Patch.parse(base + "*** Add File: file2.tx", { partial: true })).toEqual([
      { type: "add", path: "file1.txt", contents: "first file" },
    ])
    expect(Patch.parse(base + "*** Add File: file2.txt\n", { partial: true })).toEqual([
      { type: "add", path: "file1.txt", contents: "first file" },
      { type: "add", path: "file2.txt", contents: "" },
    ])
    expect(Patch.parse(base + "*** Add File: file2.txt\n+second file growing", { partial: true })).toEqual([
      { type: "add", path: "file1.txt", contents: "first file" },
      { type: "add", path: "file2.txt", contents: "second file growing" },
    ])
  })

  test("partial parse handles update hunks and growing newLines", () => {
    expect(Patch.parse("*** Begin Patch\n*** Update File: upd.txt\n", { partial: true })).toEqual([])
    expect(Patch.parse("*** Begin Patch\n*** Update File: upd.txt\n*** Move to: ren.txt\n", { partial: true })).toEqual([])
    expect(Patch.parse("*** Begin Patch\n*** Update File: upd.txt\n@@\n", { partial: true })).toEqual([])
    expect(
      Patch.parse("*** Begin Patch\n*** Update File: upd.txt\n@@ section\n-old line\n+new line   ", { partial: true }),
    ).toEqual([
      {
        type: "update",
        path: "upd.txt",
        movePath: undefined,
        chunks: [{ oldLines: ["old line"], newLines: ["new line   "], changeContext: "section", endOfFile: undefined }],
      },
    ])
    expect(
      Patch.parse("*** Begin Patch\n*** Update File: upd.txt\n@@\n-old\n+new\n@", { partial: true }),
    ).toEqual([
      {
        type: "update",
        path: "upd.txt",
        movePath: undefined,
        chunks: [{ oldLines: ["old"], newLines: ["new"], changeContext: undefined, endOfFile: undefined }],
      },
    ])
  })

  test("strict mode rejects missing markers and incomplete updates", () => {
    expect(() => Patch.parse("*** Begin Patch\n*** Add File: add.txt\n+added")).toThrow(
      "missing Begin/End markers",
    )
    expect(() => Patch.parse("*** Begin Patch\n*** Add File: add.txt\n+added", { partial: false })).toThrow(
      "missing Begin/End markers",
    )
    expect(() => Patch.parse("*** Begin Patch\n*** Update File: update.txt\n*** End Patch")).toThrow(
      "expected at least one @@ chunk",
    )
    expect(() =>
      Patch.parse("*** Begin Patch\n*** Update File: update.txt\n*** End Patch", { partial: false }),
    ).toThrow("expected at least one @@ chunk")
  })
})
