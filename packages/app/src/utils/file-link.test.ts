import { describe, expect, test } from "bun:test"
import { filePathFromHref, isExecutablePath, isImagePath, resolveFilePath } from "./file-link"

describe("filePathFromHref", () => {
  test("keeps web links external", () => {
    for (const href of ["https://a.com/x.png", "http://x", "mailto:a@b.c", "//cdn/x", "vscode://file/a", "#top"])
      expect(filePathFromHref(href)).toBeUndefined()
  })

  test("extracts file paths", () => {
    expect(filePathFromHref("src/app.ts")).toBe("src/app.ts")
    expect(filePathFromHref("./docs/a%20b.md")).toBe("./docs/a b.md")
    expect(filePathFromHref("/root/code/x.ts")).toBe("/root/code/x.ts")
    expect(filePathFromHref("file:///root/code/x.ts")).toBe("/root/code/x.ts")
    expect(filePathFromHref("file:///C:/work/x.ts")).toBe("C:/work/x.ts")
    expect(filePathFromHref("C:\\work\\x.ts")).toBe("C:\\work\\x.ts")
  })

  test("drops line suffixes", () => {
    expect(filePathFromHref("src/app.ts:12")).toBe("src/app.ts")
    expect(filePathFromHref("app.ts:12:4")).toBe("app.ts")
    expect(filePathFromHref("src/app.ts#L12-L20")).toBe("src/app.ts")
    expect(filePathFromHref("src/app.ts:10-20")).toBe("src/app.ts")
  })
})

describe("resolveFilePath", () => {
  test("joins relative paths with the workspace", () => {
    expect(resolveFilePath("/root/code/web", "src/a.ts")).toBe("/root/code/web/src/a.ts")
    expect(resolveFilePath("/root/code/web/", "./docs/../a.png")).toBe("/root/code/web/a.png")
    expect(resolveFilePath("/root/code/web", "/etc/hosts")).toBe("/etc/hosts")
    expect(resolveFilePath("C:\\work", "src/a.ts")).toBe("C:\\work\\src\\a.ts")
    expect(resolveFilePath("/root", "~/a.png")).toBe("~/a.png")
  })
})

test("classifies paths", () => {
  expect(isImagePath("a/b/Shot.PNG")).toBe(true)
  expect(isImagePath("a/b.ts")).toBe(false)
  expect(isExecutablePath("run.sh")).toBe(true)
  expect(isExecutablePath("notes.md")).toBe(false)
})
