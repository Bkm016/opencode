import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { List } from "@opencode-ai/ui/list"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { createMemo, createResource } from "solid-js"
import { useLanguage } from "@/context/language"
import { ServerConnection } from "@/context/server"
import { useGlobal } from "@/context/global"
import { displayPickerPath } from "./directory-picker-domain"

interface DialogSelectDirectoryProps {
  title?: string
  multiple?: boolean
  onSelect: (result: string | string[] | null) => void
  server: ServerConnection.Any
}

type Row = {
  absolute: string
  search: string
}

function toRow(absolute: string, home: string): Row {
  const full = displayPickerPath(absolute, "", "")
  const tilde = displayPickerPath(full, "~", home)
  const withSlash = (value: string) => {
    if (!value) return ""
    if (value.endsWith("/")) return value
    return value + "/"
  }

  const search = Array.from(
    new Set([full, withSlash(full), tilde, withSlash(tilde), getFilename(full)].filter(Boolean)),
  ).join("\n")
  return { absolute: full, search }
}

function uniqueRows(rows: Row[]) {
  const seen = new Set<string>()
  return rows.filter((row) => {
    if (seen.has(row.absolute)) return false
    seen.add(row.absolute)
    return true
  })
}

export function DialogSelectDirectory(props: DialogSelectDirectoryProps) {
  const global = useGlobal()
  const { sync, sdk, ...serverCtx } = global.ensureServerCtx(props.server)
  const dialog = useDialog()
  const language = useLanguage()

  const missingBase = createMemo(() => !(sync.data.path.home || sync.data.path.directory))
  const [fallbackPath] = createResource(
    () => (missingBase() ? true : undefined),
    async () => {
      return sdk.client.path
        .get()
        .then((x) => x.data)
        .catch(() => undefined)
    },
    { initialValue: undefined },
  )

  const home = createMemo(() => sync.data.path.home || fallbackPath()?.home || "")

  const recentProjects = createMemo(() => {
    const projects = serverCtx.projects.list()
    const byProject = new Map<string, number>()

    for (const project of projects) {
      let at = 0
      const dirs = [project.worktree, ...(project.sandboxes ?? [])]
      for (const directory of dirs) {
        const sessions = sync.child(directory, { bootstrap: false })[0].session
        for (const session of sessions) {
          if (session.time.archived) continue
          const updated = session.time.updated ?? session.time.created
          if (updated > at) at = updated
        }
      }
      byProject.set(project.worktree, at)
    }

    return projects
      .map((project, index) => ({ project, at: byProject.get(project.worktree) ?? 0, index }))
      .sort((a, b) => b.at - a.at || a.index - b.index)
      .slice(0, 5)
      .map(({ project }) => {
        const row = toRow(project.worktree, home())
        const name = project.name || getFilename(project.worktree)
        return {
          ...row,
          search: `${row.search}\n${name}`,
        }
      })
  })

  const items = createMemo(() => uniqueRows(recentProjects()))

  function resolve(absolute: string) {
    props.onSelect(props.multiple ? [absolute] : absolute)
    dialog.close()
  }

  return (
    <Dialog title={props.title ?? language.t("command.project.open")}>
      <List
        class="px-3"
        search={{ placeholder: language.t("dialog.directory.search.placeholder"), autofocus: true }}
        emptyMessage={language.t("dialog.directory.empty")}
        loadingMessage={language.t("common.loading")}
        items={items}
        key={(x) => x.absolute}
        filterKeys={["search"]}
        onSelect={(path) => {
          if (!path) return
          resolve(path.absolute)
        }}
      >
        {(item) => {
          const path = displayPickerPath(item.absolute, "", home())
          if (path === "~") {
            return (
              <div class="w-full flex items-center justify-between rounded-md">
                <div class="flex items-center gap-x-3 grow min-w-0">
                  <FileIcon node={{ path: item.absolute, type: "directory" }} class="shrink-0 size-4" />
                  <div class="flex items-center text-14-regular min-w-0">
                    <span class="text-text-strong whitespace-nowrap">~</span>
                    <span class="text-text-weak whitespace-nowrap">/</span>
                  </div>
                </div>
              </div>
            )
          }
          return (
            <div class="w-full flex items-center justify-between rounded-md">
              <div class="flex items-center gap-x-3 grow min-w-0">
                <FileIcon node={{ path: item.absolute, type: "directory" }} class="shrink-0 size-4" />
                <div class="flex items-center text-14-regular min-w-0">
                  <span class="text-text-weak whitespace-nowrap overflow-hidden overflow-ellipsis truncate min-w-0">
                    {getDirectory(path)}
                  </span>
                  <span class="text-text-strong whitespace-nowrap">{getFilename(path)}</span>
                  <span class="text-text-weak whitespace-nowrap">/</span>
                </div>
              </div>
            </div>
          )
        }}
      </List>
    </Dialog>
  )
}
