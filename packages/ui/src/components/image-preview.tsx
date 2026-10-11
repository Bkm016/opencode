import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { createSignal, onCleanup, onMount } from "solid-js"
import { useI18n } from "../context/i18n"
import { IconButton } from "./icon-button"

export interface ImagePreviewProps {
  src: string
  alt?: string
}

// 缩放倍数相对“适应窗口”的尺寸；1 即适应窗口
const MIN = 1
const MAX = 12
const STEP = 1.5

type View = { s: number; x: number; y: number }

export function ImagePreview(props: ImagePreviewProps) {
  const i18n = useI18n()
  let body!: HTMLDivElement
  let img!: HTMLImageElement
  const [view, setView] = createSignal<View>({ s: 1, x: 0, y: 0 })
  const [animate, setAnimate] = createSignal(false)
  const [dragging, setDragging] = createSignal(false)
  const [natural, setNatural] = createSignal(0)

  // 平移限制在图片不离开视口的范围内；未放大时居中
  const clamp = (next: View): View => {
    const s = Math.min(MAX, Math.max(MIN, next.s))
    const limitX = Math.max(0, (img.offsetWidth * s - body.clientWidth) / 2)
    const limitY = Math.max(0, (img.offsetHeight * s - body.clientHeight) / 2)
    return {
      s,
      x: Math.min(limitX, Math.max(-limitX, next.x)),
      y: Math.min(limitY, Math.max(-limitY, next.y)),
    }
  }

  // 以视口内某点（相对视口中心）为锚点缩放，锚点下的像素保持不动
  const zoomAt = (target: number, px = 0, py = 0, smooth = false) => {
    const current = view()
    const s = Math.min(MAX, Math.max(MIN, target))
    const ratio = s / current.s
    setAnimate(smooth)
    setView(clamp({ s, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio }))
  }

  const local = (clientX: number, clientY: number) => {
    const rect = body.getBoundingClientRect()
    return [clientX - rect.left - rect.width / 2, clientY - rect.top - rect.height / 2] as const
  }

  // 1:1 实际像素对应的倍数；图片本身比视口小时就是适应窗口
  const actual = () => (img?.offsetWidth ? Math.max(MIN, natural() / img.offsetWidth) : MIN)
  const percent = () => {
    const width = img?.offsetWidth
    if (!width || !natural()) return Math.round(view().s * 100)
    return Math.round(((view().s * width) / natural()) * 100)
  }

  const reset = () => {
    setAnimate(true)
    setView({ s: 1, x: 0, y: 0 })
  }
  const toggle = (px: number, py: number) => {
    if (view().s > 1.01) return reset()
    zoomAt(Math.max(2.5, actual()), px, py, true)
  }

  const pointers = new Map<number, { x: number; y: number }>()
  let pinch: { dist: number; s: number } | undefined
  let tap: { at: number; x: number; y: number } | undefined
  let pointerType = "mouse"

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return
    pointerType = event.pointerType
    body.setPointerCapture(event.pointerId)
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()]
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), s: view().s }
    }
    // 触屏双击：浏览器不一定派发 dblclick，自己判定
    if (event.pointerType !== "mouse" && pointers.size === 1) {
      const now = Date.now()
      if (tap && now - tap.at < 300 && Math.hypot(tap.x - event.clientX, tap.y - event.clientY) < 30) {
        tap = undefined
        toggle(...local(event.clientX, event.clientY))
        return
      }
      tap = { at: now, x: event.clientX, y: event.clientY }
    }
  }

  const onPointerMove = (event: PointerEvent) => {
    const prev = pointers.get(event.pointerId)
    if (!prev) return
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      zoomAt((pinch.s * dist) / pinch.dist, ...local((a.x + b.x) / 2, (a.y + b.y) / 2))
      return
    }
    if (pointers.size !== 1 || view().s <= 1) return
    setDragging(true)
    setAnimate(false)
    const current = view()
    setView(clamp({ s: current.s, x: current.x + event.clientX - prev.x, y: current.y + event.clientY - prev.y }))
  }

  const onPointerUp = (event: PointerEvent) => {
    pointers.delete(event.pointerId)
    if (pointers.size < 2) pinch = undefined
    if (pointers.size === 0) setDragging(false)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key === "+" || event.key === "=") zoomAt(view().s * STEP, 0, 0, true)
    else if (event.key === "-" || event.key === "_") zoomAt(view().s / STEP, 0, 0, true)
    else if (event.key === "0") reset()
    else return
    event.preventDefault()
  }

  onMount(() => {
    // 滚轮缩放需要阻止页面滚动，必须是非 passive 监听
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY
      zoomAt(view().s * Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.002)), ...local(event.clientX, event.clientY))
    }
    // 窗口尺寸变化后重新约束平移范围
    const onResize = () => setView(clamp(view()))
    body.addEventListener("wheel", onWheel, { passive: false })
    window.addEventListener("resize", onResize)
    onCleanup(() => {
      body.removeEventListener("wheel", onWheel)
      window.removeEventListener("resize", onResize)
    })
  })

  return (
    <div data-component="image-preview">
      <div data-slot="image-preview-container">
        <Kobalte.Content data-slot="image-preview-content" onKeyDown={onKeyDown}>
          <div data-slot="image-preview-header">
            <div data-slot="image-preview-zoom">
              <IconButton
                icon="dash"
                variant="ghost"
                disabled={view().s <= MIN}
                onClick={() => zoomAt(view().s / STEP, 0, 0, true)}
                aria-label={i18n.t("ui.imagePreview.zoomOut")}
                title={i18n.t("ui.imagePreview.zoomOut")}
              />
              <button
                type="button"
                data-slot="image-preview-percent"
                onClick={reset}
                title={i18n.t("ui.imagePreview.fit")}
              >
                {percent()}%
              </button>
              <IconButton
                icon="plus"
                variant="ghost"
                disabled={view().s >= MAX}
                onClick={() => zoomAt(view().s * STEP, 0, 0, true)}
                aria-label={i18n.t("ui.imagePreview.zoomIn")}
                title={i18n.t("ui.imagePreview.zoomIn")}
              />
              <button
                type="button"
                data-slot="image-preview-actual"
                onClick={() => zoomAt(actual(), 0, 0, true)}
                title={i18n.t("ui.imagePreview.actual")}
              >
                1:1
              </button>
            </div>
            <Kobalte.CloseButton
              data-slot="image-preview-close"
              as={IconButton}
              icon="close"
              variant="ghost"
              aria-label={i18n.t("ui.common.close")}
            />
          </div>
          <div
            ref={body}
            data-slot="image-preview-body"
            data-zoomed={view().s > 1 ? "true" : "false"}
            data-dragging={dragging() ? "true" : "false"}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDblClick={(event) => {
              // 触屏双击已在 pointerdown 里处理，浏览器随后补发的 dblclick 忽略
              if (pointerType !== "mouse") return
              toggle(...local(event.clientX, event.clientY))
            }}
          >
            <img
              ref={img}
              src={props.src}
              alt={props.alt ?? i18n.t("ui.imagePreview.alt")}
              data-slot="image-preview-image"
              data-animate={animate() ? "true" : "false"}
              draggable={false}
              onLoad={() => setNatural(img.naturalWidth)}
              style={{ transform: `translate(${view().x}px, ${view().y}px) scale(${view().s})` }}
            />
          </div>
        </Kobalte.Content>
      </div>
    </div>
  )
}
