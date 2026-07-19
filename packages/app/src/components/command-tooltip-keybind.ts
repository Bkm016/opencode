type CommandKeybind = {
  keybindParts: (id: string) => string[]
}

export function newTabTooltipKeybind(command: CommandKeybind, _translate?: (key: string) => string) {
  return command.keybindParts("tab.new")
}
