export function terminalWebSocketURL(input: {
  url: string
  id: string
  directory: string
  cursor: number
  ticket: string
}) {
  const next = new URL(`${input.url}/pty/${input.id}/connect`)
  next.searchParams.set("directory", input.directory)
  next.searchParams.set("cursor", String(input.cursor))
  next.protocol = next.protocol === "https:" ? "wss:" : "ws:"
  if (!input.ticket) throw new Error("PTY connection requires a short-lived ticket")
  next.username = ""
  next.password = ""
  next.searchParams.set("ticket", input.ticket)
  return next
}
