import gsap from "gsap"

export function prefersReducedMotion() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

export function gsapEnter(
  root: HTMLElement | null | undefined,
  options?: {
    x?: number
    y?: number
    scale?: number
    stagger?: number
    duration?: number
    delay?: number
    from?: "children" | "self"
  },
) {
  if (!root || prefersReducedMotion()) return
  const duration = options?.duration ?? 0.45
  const delay = options?.delay ?? 0
  const from = options?.from ?? "self"
  const targets = from === "children" ? Array.from(root.children) : root
  if (from === "children" && (targets as Element[]).length === 0) return

  const vars: gsap.TweenVars = {
    opacity: 0,
    duration,
    delay,
    ease: "power3.out",
    clearProps: "opacity,transform",
  }
  if (options?.x !== undefined) vars.x = options.x
  if (options?.y !== undefined) vars.y = options.y
  if (options?.x === undefined && options?.y === undefined) vars.y = 14
  if (options?.scale !== undefined) vars.scale = options.scale
  if (from === "children") vars.stagger = options?.stagger ?? 0.06

  return gsap.from(targets, vars)
}

export function gsapSplash(el: HTMLElement | null | undefined) {
  if (!el || prefersReducedMotion()) return
  gsap.set(el, { opacity: 0.45, scale: 0.96 })
  return gsap.to(el, {
    opacity: 0.9,
    scale: 1.05,
    duration: 0.9,
    ease: "power1.inOut",
    yoyo: true,
    repeat: -1,
  })
}
