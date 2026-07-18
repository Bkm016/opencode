import { describe, expect, test } from "bun:test"
import path from "path"
import { Shell } from "@opencode-ai/core/shell"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { which } from "@opencode-ai/core/util/which"

const withShell = async (shell: string | undefined, fn: () => void | Promise<void>) => {
  const prev = process.env.SHELL
  if (shell === undefined) delete process.env.SHELL
  else process.env.SHELL = shell
  Shell.acceptable.reset()
  Shell.preferred.reset()
  try {
    await fn()
  } finally {
    if (prev === undefined) delete process.env.SHELL
    else process.env.SHELL = prev
    Shell.acceptable.reset()
    Shell.preferred.reset()
  }
}

describe("shell", () => {
  test("normalizes shell names", () => {
    expect(Shell.name("/bin/bash")).toBe("bash")
    if (process.platform === "win32") {
      expect(Shell.name("C:/tools/NU.EXE")).toBe("nu")
      expect(Shell.name("C:/tools/PWSH.EXE")).toBe("pwsh")
    }
  })

  test("detects login shells", () => {
    expect(Shell.login("/bin/bash")).toBe(true)
    expect(Shell.login("C:/tools/pwsh.exe")).toBe(false)
  })

  test("detects posix shells", () => {
    expect(Shell.posix("/bin/bash")).toBe(true)
    expect(Shell.posix("/bin/fish")).toBe(false)
    expect(Shell.posix("C:/tools/pwsh.exe")).toBe(false)
  })

  test("falls back when configured shell cannot be resolved", async () => {
    await withShell(undefined, async () => {
      const preferred = Shell.preferred()
      const acceptable = Shell.acceptable()
      expect(Shell.preferred("opencode-missing-shell")).toBe(preferred)
      expect(Shell.acceptable("opencode-missing-shell")).toBe(acceptable)
    })
  })

  test("falls back for terminal-only acceptable shells", () => {
    expect(Shell.name(Shell.acceptable("fish"))).not.toBe("fish")
    expect(Shell.name(Shell.acceptable("nu"))).not.toBe("nu")
  })

  test("flattens PowerShell CLIXML error streams", () => {
    const raw =
      '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">At line:1 char:11_x000D__x000A_</S><S S="Error">+ if ($true { "语法错误" }_x000D__x000A_</S><S S="Error">+           ~_x000D__x000A_</S><S S="Error">Unexpected token \'{\' in expression or statement._x000D__x000A_</S></Objs>'
    const plain = Shell.plain(raw)
    expect(plain).toContain("语法错误")
    expect(plain).toContain("Unexpected token")
    expect(plain).not.toContain("CLIXML")
    expect(plain).not.toContain("_x000A_")
    expect(plain).not.toContain("<Objs")
  })

  test("keeps stdout interleaved with PowerShell CLIXML", () => {
    const raw = [
      "#< CLIXML",
      "开始",
      "这行仍会执行",
      '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T></TN></Obj><S S="Error">this-is-not-a-valid-command : The term \'this-is-not-a-valid-command\' is not recognized_x000D__x000A_</S><S S="Error">At line:1 char:238_x000D__x000A_</S><S S="Error">+ ... Write-Host "开始"; this-is-not-a-valid-command -foo ba ..._x000D__x000A_</S></Objs>',
    ].join("\n")
    const plain = Shell.plain(raw)
    expect(plain).toContain("开始")
    expect(plain).toContain("这行仍会执行")
    expect(plain).toContain("this-is-not-a-valid-command")
    expect(plain).toContain('Write-Host "开始"')
    expect(plain).not.toContain("CLIXML")
    expect(plain).not.toContain("Preparing modules")
    expect(plain).not.toContain("<Objs")
  })

  test("drops progress-only PowerShell CLIXML", () => {
    const raw =
      '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><MS><PR N="Record"><AV>Preparing modules for first use.</AV></PR></MS></Obj></Objs>\r\n'
    expect(Shell.plain(raw).trim()).toBe("")
  })

  test("builds command args per shell family", () => {
    expect(Shell.args("/bin/sh", "echo hi", "/tmp")).toEqual(["-c", "echo hi"])
    expect(Shell.args("/usr/bin/fish", "echo hi", "/tmp")).toEqual(["-c", "echo hi"])
    const zsh = Shell.args("/bin/zsh", "echo hi", "/tmp")
    expect(zsh[0]).toBe("-l")
    expect(zsh[1]).toBe("-c")
    expect(zsh.at(-1)).toBe("/tmp")

    const ps = Shell.args("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", "Write-Host hi", "C:/tmp")
    expect(ps.slice(0, 3)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive"])
    if (process.platform === "win32") {
      expect(ps[3]).toBe("-EncodedCommand")
      const decoded = Buffer.from(String(ps[4]), "base64").toString("utf16le")
      expect(decoded).toContain("UTF8Encoding")
      expect(decoded).toContain("Write-Host hi")

      const launch = Shell.launch("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", 'Write-Host "开始"', "C:/tmp")
      expect(launch.command.toLowerCase()).toContain("cmd")
      expect(launch.args[0]).toBe("/d")
      expect(launch.args[1]).toBe("/c")
      expect(launch.args[2]).toContain("chcp 65001")
      expect(launch.args[2]).toContain("-EncodedCommand")
      const enc = launch.args[2].match(/-EncodedCommand\s+(\S+)/)?.[1]
      expect(enc).toBeTruthy()
      expect(Buffer.from(enc!, "base64").toString("utf16le")).toContain("开始")
    } else {
      expect(ps[3]).toBe("-Command")
      expect(ps[4]).toBe("Write-Host hi")
    }
  })

  if (process.platform === "win32") {
    test("rejects blacklisted shells case-insensitively", async () => {
      await withShell("NU.EXE", async () => {
        expect(Shell.name(Shell.acceptable())).not.toBe("nu")
      })
    })

    test("normalizes Git Bash shell paths from env", async () => {
      const shell = "/cygdrive/c/Program Files/Git/bin/bash.exe"
      await withShell(shell, async () => {
        expect(Shell.preferred()).toBe(FSUtil.windowsPath(shell))
      })
    })

    test("resolves /usr/bin/bash from env to Git Bash", async () => {
      const bash = Shell.gitbash()
      if (!bash) return
      await withShell("/usr/bin/bash", async () => {
        expect(Shell.acceptable()).toBe(bash)
        expect(Shell.preferred()).toBe(bash)
      })
    })

    test("resolves bare bash to Git Bash before PATH", async () => {
      const bash = Shell.gitbash()
      if (!bash) return
      expect(Shell.acceptable("bash")).toBe(bash)
      expect(Shell.preferred("bash")).toBe(bash)
      await withShell("bash", async () => {
        expect(Shell.acceptable()).toBe(bash)
        expect(Shell.preferred()).toBe(bash)
      })
    })

    test("resolves bare PowerShell shells", async () => {
      const shell = which("pwsh") || which("powershell")
      if (!shell) return
      await withShell(path.win32.basename(shell), async () => {
        expect(Shell.preferred()).toBe(shell)
      })
    })
  }
})
