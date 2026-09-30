import { DataProvider } from "@opencode-ai/session-ui/context"
import { showToast } from "@/utils/toast"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { type Accessor, createEffect, createMemo, on, onCleanup, type ParentProps, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { LocalProvider } from "@/context/local"
import { SDKProvider } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { decode64 } from "@/utils/base64"
import { Schema } from "effect"
import { type ServerConnection, useServer } from "@/context/server"
import { sessionHref } from "@/utils/session-route"
import { useServerSync } from "@/context/server-sync"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ImagePreview } from "@opencode-ai/ui/image-preview"
import { MarkdownFilesProvider } from "@opencode-ai/session-ui/context/markdown-files"
import { filePathFromHref, isExecutablePath, isImagePath, resolveFilePath } from "@/utils/file-link"
import { createLocalImages } from "@/utils/local-images"

export function DirectoryDataProvider(
  props: ParentProps<{
    directory: string | Accessor<string>
    draftID?: string
    server?: Accessor<ServerConnection.Key | undefined>
  }>,
) {
  const location = useLocation()
  const navigate = useNavigate()
  const params = useParams()
  const sync = useSync()
  const serverSync = useServerSync()
  const platform = usePlatform()
  const server = useServer()
  const serverSDK = useServerSDK()
  const dialog = useDialog()
  const language = useLanguage()
  const images = createLocalImages({
    server: () => serverSDK().server,
    fetch: platform.fetch,
  })
  const directory = () => (typeof props.directory === "function" ? props.directory() : props.directory)
  const slug = createMemo(() => base64Encode(directory()))
  const href = (sessionID: string, targetDirectory?: string) => {
    const server = props.server?.()
    if (server) return sessionHref(server, sessionID)
    // 跨项目子会话必须使用目标目录生成 legacy 路由。
    if (targetDirectory) return `/${base64Encode(targetDirectory)}/session/${sessionID}`
    return `/${slug()}/session/${sessionID}`
  }

  createEffect(() => {
    // A draft lives at /new-session?draftId=… and has no directory segment to normalize.
    if (props.draftID || props.server?.()) return
    const next = sync().data.path.directory
    if (!next || next === directory()) return
    const path = location.pathname.slice(slug().length + 1)
    navigate(`/${base64Encode(next)}${path}${location.search}${location.hash}`, { replace: true })
  })

  createEffect(
    on([() => params.id, sync] as const, ([id, current]) => {
      if (!id) return
      void current.session.sync(id).catch(() => {})
    }),
  )

  createEffect(() => {
    const sessionID = params.id
    if (!sessionID) return
    serverSync().session.pin(sessionID)
    onCleanup(() => serverSync().session.unpin(sessionID))
  })

  // 消息里的文件链接：图片直接预览；本机服务器用系统默认应用打开；远程或网页端复制路径
  const openFile = async (file: string) => {
    const path = resolveFilePath(directory(), file)
    if (isImagePath(path)) {
      const src = await images.get(directory(), path)
      if (src) return dialog.show(() => <ImagePreview src={src} alt={file} />)
    }
    if (platform.platform === "desktop" && server.isLocal() && platform.openPath) {
      const opened = isExecutablePath(path)
        ? platform.revealPath?.(path).then((found) => {
            if (!found) throw new Error(language.t("fileLink.missing", { path }))
          })
        : platform.openPath(path)
      return opened?.catch((err) =>
        showToast({ variant: "error", title: language.t("fileLink.openFailed"), description: String(err) }),
      )
    }
    const copied = await navigator.clipboard?.writeText(path).then(
      () => true,
      () => false,
    )
    showToast({
      variant: copied ? "default" : "error",
      title: language.t(copied ? "fileLink.copied" : "fileLink.openFailed"),
      description: path,
    })
  }

  return (
    <Show when={directory()} keyed>
      {(directory) => (
        <DataProvider
          data={sync().data}
          directory={directory}
          onNavigateToSession={(sessionID: string, directory?: string) => navigate(href(sessionID, directory))}
          onSessionHref={href}
        >
          <LocalProvider>
            <MarkdownFilesProvider
              value={{
                image: (path) => images.get(directory, path),
                preview: (src, alt) => dialog.show(() => <ImagePreview src={src} alt={alt} />),
              }}
            >
              <div
                class="contents"
                on:click={(event) => {
                  if (event.defaultPrevented) return
                  const link =
                    event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a.external-link") : null
                  // 用原始 href：link.href 已被页面 base 解析成 oc://renderer/…
                  const file = filePathFromHref(link?.getAttribute("href") ?? "")
                  if (!link || !file) return
                  event.preventDefault()
                  event.stopPropagation()
                  void openFile(file)
                }}
              >
                {props.children}
              </div>
            </MarkdownFilesProvider>
          </LocalProvider>
        </DataProvider>
      )}
    </Show>
  )
}

export const ProjectDirString = Schema.String.pipe(Schema.brand("ProjectDirString"))
export type ProjectDirString = Schema.Schema.Type<typeof ProjectDirString>

export function decodeDirectory(dir: string): ProjectDirString | undefined {
  const decoded = decode64(dir)
  if (!decoded) return
  return ProjectDirString.make(decoded)
}

export default function Layout(props: ParentProps) {
  const params = useParams()
  const language = useLanguage()
  const navigate = useNavigate()
  let invalid = ""

  const resolved = createMemo(() => {
    if (!params.dir) return ""
    return decodeDirectory(params.dir) ?? ""
  })

  createEffect(() => {
    const dir = params.dir
    if (!dir) return
    if (resolved()) {
      invalid = ""
      return
    }
    if (invalid === dir) return
    invalid = dir
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: language.t("directory.error.invalidUrl"),
    })
    navigate("/", { replace: true })
  })

  return (
    <Show when={resolved()} keyed>
      {(resolved) => (
        <SDKProvider directory={resolved}>
          <DirectoryDataProvider directory={resolved}>{props.children}</DirectoryDataProvider>
        </SDKProvider>
      )}
    </Show>
  )
}
