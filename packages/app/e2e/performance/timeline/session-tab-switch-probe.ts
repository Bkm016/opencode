import { expect, type Page } from "@playwright/test"
import { isStableDestination, type SessionSwitchSample } from "./session-tab-switch-metrics"

export async function waitForStableTimeline(page: Page, lastID: string) {
  const samples: Pick<SessionSwitchSample, "last" | "bottomErrorPx">[] = []
  await expect
    .poll(
      async () => {
        samples.push(
          await page.evaluate(
            (lastID) =>
              new Promise<Pick<SessionSwitchSample, "last" | "bottomErrorPx">>((resolve) => {
                requestAnimationFrame(() =>
                  setTimeout(() => {
                    const root = [...document.querySelectorAll<HTMLElement>(".scroll-view__viewport")].find((element) =>
                      element.querySelector("[data-timeline-row]"),
                    )
                    if (!root) {
                      resolve({ last: false })
                      return
                    }
                    const view = root.getBoundingClientRect()
                    const last = [...root.querySelectorAll<HTMLElement>("[data-message-id]")].some((element) => {
                      if (element.dataset.messageId !== lastID) return false
                      const rect = element.getBoundingClientRect()
                      return rect.bottom > view.top && rect.top < view.bottom
                    })
                    const spacer = root
                      .querySelector<HTMLElement>('[data-timeline-row="bottom-spacer"]')
                      ?.getBoundingClientRect()
                    resolve({ last, bottomErrorPx: spacer ? spacer.bottom - view.bottom : undefined })
                  }, 0),
                )
              }),
            lastID,
          ),
        )
        return isStableDestination(samples.slice(-3))
      },
      { timeout: 30_000, intervals: [0] },
    )
    .toBe(true)
}
