import gsap from "gsap"

export function bindFileStreamMotion(root: ShadowRoot) {
  const previous = new Map<string, string>()
  const active = new Set<HTMLSpanElement>()
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)")
  const release = (span: HTMLSpanElement) => {
    gsap.killTweensOf(span)
    span.replaceWith(...Array.from(span.childNodes))
    active.delete(span)
  }
  const scan = () => {
    // 只装饰本批追加的文本，不改变高亮 token、行号和 Diff 底色，也不重播已显示的前缀。
    observer.disconnect()
    active.forEach((span) => {
      if (!span.isConnected || reduced.matches) release(span)
    })
    const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-code] [data-line]"))
    const keys = new Set<string>()
    rows.forEach((row, index) => {
      const side = row.closest("[data-code]")?.hasAttribute("data-deletions") ? "deletions" : "additions"
      const key = `${side}:${row.dataset.line}:${row.dataset.altLine ?? ""}`
      // 渲染器的行尾换行不属于追加前缀，否则同一行继续出字会被误判为替换。
      const text = (row.textContent ?? "").replace(/\r?\n$/, "")
      const before = previous.get(key) ?? ""
      keys.add(key)
      previous.set(key, text)
      if (text === before || !text.startsWith(before) || reduced.matches) return
      // 展开已有的大预览时只淡入尾部，避免几百行同时建立动画。
      if (!before && index < rows.length - 12) return
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
      const nodes: Text[] = []
      let node = walker.nextNode()
      while (node) {
        nodes.push(node as Text)
        node = walker.nextNode()
      }
      let offset = 0
      const batch = nodes.flatMap((node) => {
        const start = offset
        offset += node.length
        if (offset <= before.length || start >= text.length || node.parentElement?.closest("[data-stream-reveal]")) return []
        const suffix = start < before.length ? node.splitText(before.length - start) : node
        const span = document.createElement("span")
        span.dataset.streamReveal = ""
        suffix.replaceWith(span)
        span.append(suffix)
        active.add(span)
        return [span]
      })
      if (!batch.length) return
      gsap.fromTo(
        batch,
        { opacity: 0.25 },
        {
          opacity: 1,
          duration: 0.24,
          ease: "power1.out",
          onComplete: () => batch.forEach(release),
        },
      )
    })
    previous.forEach((_, key) => {
      if (!keys.has(key)) previous.delete(key)
    })
    // 不观察 style 属性，避免 GSAP 自身的帧更新触发扫描。
    observer.observe(root, { childList: true, characterData: true, subtree: true })
  }
  const observer = new MutationObserver(scan)
  scan()
  reduced.addEventListener("change", scan)
  return () => {
    observer.disconnect()
    reduced.removeEventListener("change", scan)
    active.forEach(release)
    previous.clear()
  }
}
