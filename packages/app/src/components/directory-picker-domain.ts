function normalizePickerPath(input: string) {
  const value = input.replaceAll("\\", "/")
  if (value.startsWith("//") && !value.startsWith("///")) return "//" + value.slice(2).replace(/\/+/g, "/")
  return value.replace(/\/+/g, "/")
}

function normalizePickerDrive(input: string) {
  const value = normalizePickerPath(input)
  if (/^[A-Za-z]:$/.test(value)) return value + "/"
  return value
}

function trimPickerPath(input: string) {
  const value = normalizePickerDrive(input)
  if (value === "/" || value === "//" || /^[A-Za-z]:\/$/.test(value)) return value
  return value.replace(/\/+$/, "")
}

function pickerTilde(absolute: string, home: string) {
  const path = trimPickerPath(absolute)
  if (!home) return ""
  const root = trimPickerPath(home)
  if (/^[A-Za-z]:\//.test(root)) return ""
  if (path === root) return "~"
  if (path.startsWith(root + "/")) return "~" + path.slice(root.length)
  return ""
}

export function displayPickerPath(path: string, input: string, home: string) {
  const value = trimPickerPath(path)
  if (/^[A-Za-z]:\//.test(trimPickerPath(home)) || /^[A-Za-z]:\//.test(value)) return value.replaceAll("/", "\\")
  return pickerTilde(value, home) || value
}
