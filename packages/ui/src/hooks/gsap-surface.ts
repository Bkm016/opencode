import gsap from "gsap"

function prefersReducedMotion() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

function safe<T>(run: () => T): T | undefined {
  try {
    return run()
  } catch {
    return undefined
  }
}

export type SurfaceMotion = "panel" | "menu" | "toast" | "tooltip" | "dialog" | "overlay"

const presets: Record<
  SurfaceMotion,
  {
    y: number
    scale: number
    duration: number
    ease: string
  }
> = {
  panel: { y: 10, scale: 0.97, duration: 0.2, ease: "power2.out" },
  menu: { y: 8, scale: 0.97, duration: 0.18, ease: "power2.out" },
  toast: { y: 12, scale: 0.96, duration: 0.22, ease: "power2.out" },
  tooltip: { y: 4, scale: 0.98, duration: 0.14, ease: "power2.out" },
  dialog: { y: 12, scale: 0.97, duration: 0.22, ease: "power2.out" },
  overlay: { y: 0, scale: 1, duration: 0.18, ease: "power1.out" },
}

/** Shared open motion for tray / select / popover / menu / toast surfaces. */
export function animateSurfaceIn(
  el: HTMLElement | null | undefined,
  options?: {
    y?: number
    scale?: number
    duration?: number
    ease?: string
    preset?: SurfaceMotion
  },
) {
  return safe(() => {
    if (!el || prefersReducedMotion()) return
    const base = presets[options?.preset ?? "panel"]
    const duration = options?.duration ?? base.duration
    const y = options?.y ?? base.y
    const scale = options?.scale ?? base.scale
    const ease = options?.ease ?? base.ease
    gsap.killTweensOf(el)
    if (options?.preset === "overlay") {
      return gsap.fromTo(
        el,
        { opacity: 0 },
        {
          opacity: 1,
          duration,
          ease,
          clearProps: "opacity",
        },
      )
    }
    return gsap.fromTo(
      el,
      { opacity: 0, y, scale },
      {
        opacity: 1,
        y: 0,
        scale: 1,
        duration,
        ease,
        clearProps: "opacity,transform",
      },
    )
  })
}

/** Stagger list rows inside a surface after it opens. Opacity only — y would flash scrollbars. */
export function animateSurfaceItems(
  root: HTMLElement | null | undefined,
  selector = "[data-slot='select-select-item'], [data-component='menu-v2-item'], [role='option'], [data-slot='dropdown-menu-item'], [data-slot='context-menu-item']",
) {
  return safe(() => {
    if (!root || prefersReducedMotion()) return
    const items = root.querySelectorAll(selector)
    if (items.length === 0) return
    gsap.killTweensOf(items)
    return gsap.fromTo(
      items,
      { opacity: 0 },
      {
        opacity: 1,
        duration: 0.12,
        stagger: 0.014,
        ease: "power2.out",
        clearProps: "opacity",
      },
    )
  })
}

/** Attach enter motion when a portalled surface mounts. */
export function bindSurfaceMotion(
  el: HTMLElement | null | undefined,
  options?: {
    preset?: SurfaceMotion
    y?: number
    scale?: number
    duration?: number
    items?: boolean | string
  },
) {
  return safe(() => {
    if (!el) return
    const tween = animateSurfaceIn(el, {
      preset: options?.preset,
      y: options?.y,
      scale: options?.scale,
      duration: options?.duration,
    })
    if (options?.items) {
      requestAnimationFrame(() => {
        animateSurfaceItems(el, typeof options.items === "string" ? options.items : undefined)
      })
    }
    return tween
  })
}

const outputSeen = new Set<string>()
let outputBurst = 0
let outputBurstAt = 0

/**
 * One-shot enter for model/timeline output blocks.
 * Skips bulk session loads (many mounts in one frame) and already-seen keys.
 */
export function animateOutputEnter(
  el: HTMLElement | null | undefined,
  key: string,
  options?: {
    y?: number
    duration?: number
  },
) {
  return safe(() => {
    if (!el || !key || prefersReducedMotion()) return
    if (outputSeen.has(key)) return
    outputSeen.add(key)
    if (outputSeen.size > 4000) {
      const drop = [...outputSeen].slice(0, 2000)
      for (const id of drop) outputSeen.delete(id)
    }

    const now = typeof performance !== "undefined" ? performance.now() : Date.now()
    if (now - outputBurstAt > 120) {
      outputBurst = 0
      outputBurstAt = now
    }
    outputBurst += 1
    // Session hydrate / virtualizer fill mounts many rows at once — don't cascade.
    if (outputBurst > 5) return

    gsap.killTweensOf(el)
    const y = options?.y ?? 0
    if (y === 0) {
      return gsap.fromTo(
        el,
        { opacity: 0.35 },
        {
          opacity: 1,
          duration: options?.duration ?? 0.22,
          ease: "power2.out",
          clearProps: "opacity",
        },
      )
    }
    return gsap.fromTo(
      el,
      {
        opacity: 0,
        y,
      },
      {
        opacity: 1,
        y: 0,
        duration: options?.duration ?? 0.28,
        ease: "power2.out",
        clearProps: "opacity,transform",
      },
    )
  })
}

/** Soft enter when expanding collapsed process steps. */
export function animateProcessReveal(nodes: ArrayLike<Element> | Element | null | undefined) {
  return safe(() => {
    if (!nodes || prefersReducedMotion()) return
    const list = "length" in nodes ? Array.from(nodes as ArrayLike<Element>) : [nodes]
    const targets = list.filter((node): node is HTMLElement => node instanceof HTMLElement && node.isConnected)
    if (targets.length === 0) return
    const batch = targets.length > 16 ? targets.slice(0, 16) : targets
    gsap.killTweensOf(batch)
    return gsap.fromTo(
      batch,
      { opacity: 0, y: 6 },
      {
        opacity: 1,
        y: 0,
        duration: 0.24,
        stagger: 0.03,
        ease: "power2.out",
        clearProps: "opacity,transform",
      },
    )
  })
}

/** Soft exit before collapsing process steps; resolves when finished. */
export function animateProcessHide(nodes: ArrayLike<Element> | Element | null | undefined) {
  return safe(() => {
    if (!nodes || prefersReducedMotion()) return Promise.resolve()
    const list = "length" in nodes ? Array.from(nodes as ArrayLike<Element>) : [nodes]
    const targets = list.filter((node): node is HTMLElement => node instanceof HTMLElement && node.isConnected)
    if (targets.length === 0) return Promise.resolve()
    const batch = targets.length > 16 ? targets.slice(0, 16) : targets
    gsap.killTweensOf(batch)
    return new Promise<void>((resolve) => {
      gsap.to(batch, {
        opacity: 0,
        y: -4,
        duration: 0.16,
        stagger: 0.012,
        ease: "power1.in",
        onComplete: () => resolve(),
      })
    })
  }) ?? Promise.resolve()
}

/** Chevron rotate for process summary expand/collapse. */
export function animateProcessChevron(el: HTMLElement | null | undefined, open: boolean) {
  return safe(() => {
    if (!el) return
    if (prefersReducedMotion()) {
      gsap.set(el, { rotate: open ? 90 : 0 })
      return
    }
    gsap.to(el, {
      rotate: open ? 90 : 0,
      duration: 0.18,
      ease: "power2.out",
      overwrite: "auto",
    })
  })
}

/** Shell / status subtitle: width spring + blur clear. */
export function animateShellSubtitle(
  widthEl: HTMLElement | null | undefined,
  valueEl: HTMLElement | null | undefined,
) {
  return safe(() => {
    if (prefersReducedMotion()) {
      if (widthEl) gsap.set(widthEl, { width: "auto" })
      if (valueEl) gsap.set(valueEl, { opacity: 1, filter: "blur(0px)" })
      return
    }
    if (widthEl) {
      gsap.fromTo(
        widthEl,
        { width: 0 },
        {
          width: "auto",
          duration: 0.32,
          ease: "power2.out",
          clearProps: "width",
        },
      )
    }
    if (valueEl) {
      gsap.fromTo(
        valueEl,
        { opacity: 0, filter: "blur(2px)" },
        {
          opacity: 1,
          filter: "blur(0px)",
          duration: 0.34,
          ease: "power2.out",
          clearProps: "opacity,filter",
        },
      )
    }
  })
}
