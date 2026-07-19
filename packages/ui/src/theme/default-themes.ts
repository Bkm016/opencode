import type { DesktopTheme } from "./types"
import amoledThemeJson from "./themes/amoled.json"
import cursorThemeJson from "./themes/cursor.json"
import opencodeThemeJson from "./themes/opencode.json"
import orngThemeJson from "./themes/orng.json"
import vercelThemeJson from "./themes/vercel.json"
import vesperThemeJson from "./themes/vesper.json"

export const amoledTheme = amoledThemeJson as DesktopTheme
export const cursorTheme = cursorThemeJson as DesktopTheme
export const opencodeTheme = opencodeThemeJson as DesktopTheme
export const orngTheme = orngThemeJson as DesktopTheme
export const vercelTheme = vercelThemeJson as DesktopTheme
export const vesperTheme = vesperThemeJson as DesktopTheme

export const DEFAULT_THEMES: Record<string, DesktopTheme> = {
  amoled: amoledTheme,
  cursor: cursorTheme,
  opencode: opencodeTheme,
  orng: orngTheme,
  vercel: vercelTheme,
  vesper: vesperTheme,
}
