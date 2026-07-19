import { describe, expect, test } from "bun:test"
import { newTabTooltipKeybind } from "./command-tooltip-keybind"

describe("command tooltip keybinds", () => {
  test("uses the configured new-tab shortcut", () => {
    const command = {
      keybind: () => "Alt+N",
      keybindParts: () => ["Alt", "N"],
    }

    expect(newTabTooltipKeybind(command, (key) => key)).toEqual(["Alt", "N"])
  })
})
