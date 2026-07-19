import { expect, test } from "bun:test"
import { displayPickerPath } from "./directory-picker-domain"

test("displays paths using the selected server path format", () => {
  expect(displayPickerPath("C:/Users/luke/repos", "C:/Users/luke/repos", "C:/Users/luke")).toBe(
    "C:\\Users\\luke\\repos",
  )
  expect(displayPickerPath("C:/Users/luke/repos", "C:\\Users\\luke\\repos", "C:/Users/luke")).toBe(
    "C:\\Users\\luke\\repos",
  )
  expect(displayPickerPath("/home/luke/repos", "repos", "/home/luke")).toBe("~/repos")
  expect(displayPickerPath("/home/luke/repos", "~/repos", "/home/luke")).toBe("~/repos")
})
