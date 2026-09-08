export async function writeClipboardImage(blob: Blob): Promise<boolean> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
  if (clipboard?.write && typeof ClipboardItem !== "undefined") {
    try {
      await clipboard.write([new ClipboardItem({ [blob.type]: blob })])
      return true
    } catch {
      // 浏览器权限受限或焦点丢失时尝试客户端扩展接口
    }
  }

  const api =
    typeof window !== "undefined"
      ? (window as unknown as { api?: { writeClipboardImage?: (dataUrl: string) => Promise<boolean> } }).api
      : undefined
  if (api?.writeClipboardImage) {
    try {
      const reader = new FileReader()
      const dataUrl = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = reject
        reader.readAsDataURL(blob)
      })
      return await api.writeClipboardImage(dataUrl)
    } catch {
      return false
    }
  }

  return false
}
