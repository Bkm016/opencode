import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { Button } from "@opencode-ai/ui/button"
import { List, type ListRef } from "@opencode-ai/ui/list"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { createMemo, createResource, createSignal, Show } from "solid-js"
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
      .filter(({ project }) => {
        const wt = project.worktree.replace(/[/\\]+$/, "")
        return wt && wt !== "/" && wt.length > 1
      })
      .map(({ project }) => {
        const row = toRow(project.worktree, home())
        const name = project.name || getFilename(project.worktree)
        return {
          ...row,
          search: `${row.search}\n${name}`,
        }
      })
  })

  const [browsing, setBrowsing] = createSignal(false)
  const [current, setCurrent] = createSignal("")
  const [failed, setFailed] = createSignal(false)
  const [filterValue, setFilterValue] = createSignal("")
  let listRef: ListRef | undefined

  const [listing] = createResource(
    () => (browsing() ? current() : undefined),
    async (target) => {
      const result = await sdk.client.experimental.file.list({ path: target }).catch(() => undefined)
      if (!result?.data) return { path: target, parent: undefined, entries: [], failed: true }
      return { ...result.data, failed: false }
    },
  )

  const browseRows = createMemo<Row[]>(() => {
    const data = listing.latest
    if (!data) return []
    const rows: Row[] = []
    if (data.parent) {
      const row = toRow(data.parent, home())
      rows.push({ ...row, search: `${row.search}\n${language.t("dialog.directory.parent")}` })
    }
    for (const entry of data.entries) {
      if (entry.kind !== "directory") continue
      rows.push(toRow(entry.path, home()))
    }
    return rows
  })

  // 进入浏览态后同步一次读取失败标记，避免加载期间闪出"无法读取"
  createMemo(() => {
    if (!browsing()) return
    if (listing.state !== "ready") return
    setFailed(listing()?.failed ?? true)
  })

  const items = createMemo(() => {
    if (!browsing()) return uniqueRows(recentProjects())
    return browseRows()
  })

  function resolve(absolute: string) {
    props.onSelect(props.multiple ? [absolute] : absolute)
    dialog.close()
  }

  function browse(target: string) {
    setBrowsing(true)
    setFailed(false)
    setCurrent(target)
    listRef?.setFilter("")
  }

  // 看起来是路径的输入直接打开：回车在最近项目视图里把搜索框内容当路径打开
  function maybeOpenTypedPath(value: string) {
    const v = value.trim()
    if (!v) return false
    if (v === "/" || v === "~" || v.startsWith("/") || v.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(v)) {
      resolve(v)
      return true
    }
    return false
  }

  return (
    <Dialog title={props.title ?? language.t("command.project.open")}>
      <List
        class="px-3"
        ref={(ref) => (listRef = ref)}
        search={{ placeholder: language.t("dialog.directory.search.placeholder"), autofocus: true }}
        emptyMessage={
          browsing() && failed()
            ? language.t("dialog.directory.readError")
            : language.t("dialog.directory.empty")
        }
        loadingMessage={language.t("common.loading")}
        items={items}
        key={(x) => (browsing() ? `browse\n${x.absolute}` : x.absolute)}
        filterKeys={["search"]}
        onFilter={(value) => setFilterValue(value)}
        onSelect={(path) => {
          if (!path) return
          if (browsing()) {
            browse(path.absolute)
            return
          }
          resolve(path.absolute)
        }}
        onKeyEvent={(event, item) => {
          if (event.key === "Escape") {
            if (browsing()) {
              event.preventDefault()
              setBrowsing(false)
              listRef?.setFilter("")
            }
            return
          }
          if (event.key === "Enter" && !item) {
            // 浏览态：选中当前目录；最近项目态：搜索框是路径就直接打开
            event.preventDefault()
            if (browsing()) {
              resolve(listing.latest?.path ?? current())
            } else if (maybeOpenTypedPath(filterValue())) {
              return
            }
          }
        }}
      >
        {(item) => {
          const path = displayPickerPath(item.absolute, "", home())
          const showBack = () => browsing() && listing.latest?.parent === item.absolute
          if (path === "~" && !showBack()) {
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
                <Show
                  when={showBack()}
                  fallback={<FileIcon node={{ path: item.absolute, type: "directory" }} class="shrink-0 size-4" />}
                >
                  <Icon name="arrow-left" class="shrink-0 size-4 text-text-weak" />
                </Show>
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
      <div class="px-3 pt-1.5 pb-2 flex items-center justify-between gap-x-3">
        <Show
          when={browsing()}
          fallback={
            <span class="text-12-regular text-text-weak truncate min-w-0">
              {language.t("dialog.directory.recent")}
            </span>
          }
        >
          <span class="text-12-regular text-text-weak truncate min-w-0 text-left">
            {displayPickerPath(listing.latest?.path ?? current(), "", home())}
          </span>
        </Show>
        <div class="flex items-center gap-x-2 shrink-0">
          <Show when={browsing()}>
            <Button
              variant="ghost"
              size="small"
              icon="arrow-left"
              onClick={() => {
                setBrowsing(false)
                listRef?.setFilter("")
              }}
            >
              {language.t("common.goBack")}
            </Button>
          </Show>
          <Button
            variant="ghost"
            size="small"
            icon={browsing() ? "check-small" : "folder"}
            onClick={() => {
              if (browsing()) resolve(listing.latest?.path ?? current())
              else browse(home() || "/")
            }}
          >
            {browsing() ? language.t("dialog.directory.action.selectFolder") : language.t("dialog.directory.browse")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
