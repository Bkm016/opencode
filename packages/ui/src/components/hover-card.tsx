import { HoverCard as Kobalte } from "@kobalte/core/hover-card"
import { ComponentProps, JSXElement, ParentProps, splitProps } from "solid-js"
import { bindSurfaceMotion } from "../hooks/gsap-surface"

export interface HoverCardProps extends ParentProps, Omit<ComponentProps<typeof Kobalte>, "children"> {
  trigger: JSXElement
  mount?: HTMLElement
  class?: ComponentProps<"div">["class"]
  classList?: ComponentProps<"div">["classList"]
}

export function HoverCard(props: HoverCardProps) {
  const [local, rest] = splitProps(props, ["trigger", "mount", "class", "classList", "children"])

  return (
    <Kobalte gutter={4} {...rest}>
      <Kobalte.Trigger as="div" data-slot="hover-card-trigger" tabIndex={-1}>
        {local.trigger}
      </Kobalte.Trigger>
      <Kobalte.Portal mount={local.mount}>
        <Kobalte.Content
          data-component="hover-card-content"
          classList={{
            ...local.classList,
            [local.class ?? ""]: !!local.class,
          }}
          ref={(el) => bindSurfaceMotion(el, { preset: "tooltip" })}
        >
          <div data-slot="hover-card-body">{local.children}</div>
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}
