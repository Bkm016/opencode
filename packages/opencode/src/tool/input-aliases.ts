import type { InputAliases } from "./tool"

const PATH_KEYS = ["filePath", "path", "file", "filepath", "file_path"] as const
const GLOB_PATTERN_KEYS = ["pattern", "glob_pattern", "glob", "file_pattern"] as const
const GREP_PATTERN_KEYS = ["pattern", "query", "search", "regex"] as const
const SEARCH_ROOT_KEYS = ["path", "target_directory", "directory", "cwd", "dir", "root"] as const
const RUN_CMD_KEYS = ["command", "cmd"] as const
const WORKDIR_KEYS = ["workdir", "working_directory", "cwd", "directory"] as const
const WRITE_BODY_KEYS = ["content", "contents", "text", "body"] as const
const EDIT_OLD_KEYS = ["oldString", "old_string", "old_str", "oldText", "old_text"] as const
const EDIT_NEW_KEYS = ["newString", "new_string", "new_str", "newText", "new_text"] as const
const EDIT_REPLACE_ALL_KEYS = ["replaceAll", "replace_all"] as const
const MULTI_EDIT_LIST_KEYS = ["edits", "changes", "operations"] as const

function to(canonical: string, keys: readonly string[]): InputAliases {
  const out: Record<string, string> = {}
  for (const key of keys) {
    if (key === canonical) continue
    out[key] = canonical
  }
  return out
}

function merge(...tables: InputAliases[]): InputAliases {
  return Object.assign({}, ...tables)
}

/** Canonical `filePath` (read / write / edit). */
export const filePath = to("filePath", PATH_KEYS)

/** Canonical directory `path` (list_dir / glob / grep search root). */
export const path = to("path", [...PATH_KEYS, ...SEARCH_ROOT_KEYS])

/** Canonical glob `pattern`. */
export const globPattern = to("pattern", GLOB_PATTERN_KEYS)

/** Canonical grep `pattern`. */
export const grepPattern = to("pattern", GREP_PATTERN_KEYS)

/** Canonical write `content`. */
export const content = to("content", WRITE_BODY_KEYS)

/** Canonical edit `oldString`. */
export const oldString = to("oldString", EDIT_OLD_KEYS)

/** Canonical edit `newString`. */
export const newString = to("newString", EDIT_NEW_KEYS)

/** Canonical edit `replaceAll`. */
export const replaceAll = to("replaceAll", EDIT_REPLACE_ALL_KEYS)

/** Canonical multiedit list key `edits`. */
export const multiEditList = to("edits", MULTI_EDIT_LIST_KEYS)

/** Canonical shell `command`. */
export const command = to("command", RUN_CMD_KEYS)

/** Canonical shell `workdir`. */
export const workdir = to("workdir", WORKDIR_KEYS)

export const read = filePath
export const write = merge(filePath, content)
export const edit = merge(filePath, oldString, newString, replaceAll)
export const multiEdit = multiEditList
export const multiEditEntry = edit
export const listDir = path
export const glob = merge(globPattern, path)
export const grep = merge(grepPattern, path)
export const shell = merge(command, workdir)

export * as InputAlias from "./input-aliases"
