import { describe, expect, test } from "bun:test"
import { terminalWebSocketURL } from "./terminal-websocket-url"

describe("terminalWebSocketURL", () => {
  test("uses a short-lived ticket without embedding URL credentials", () => {
    const url = terminalWebSocketURL({
      url: "http://opencode:secret@127.0.0.1:49365",
      id: "pty_test",
      directory: "/tmp/project",
      cursor: 0,
      ticket: "single-use-ticket",
    })

    expect(url.protocol).toBe("ws:")
    expect(url.username).toBe("")
    expect(url.password).toBe("")
    expect(url.searchParams.has("auth_token")).toBe(false)
    expect(url.searchParams.get("ticket")).toBe("single-use-ticket")
  })

  test("preserves secure transport and terminal scope", () => {
    const url = terminalWebSocketURL({
      url: "https://app.example.test",
      id: "pty_test",
      directory: "/tmp/project",
      cursor: 10,
      ticket: "single-use-ticket",
    })

    expect(url.protocol).toBe("wss:")
    expect(url.searchParams.has("auth_token")).toBe(false)
    expect(url.searchParams.get("directory")).toBe("/tmp/project")
    expect(url.searchParams.get("cursor")).toBe("10")
  })

  test("rejects missing tickets instead of falling back to password authentication", () => {
    expect(() =>
      terminalWebSocketURL({
        url: "https://app.example.test",
        id: "pty_test",
        directory: "/tmp/project",
        cursor: 10,
        ticket: "",
      }),
    ).toThrow("short-lived ticket")
  })
})
