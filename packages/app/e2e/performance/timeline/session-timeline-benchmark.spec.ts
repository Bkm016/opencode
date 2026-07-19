import type { Page } from "@playwright/test"
import { benchmark, benchmarkDiagnostics, expect } from "../benchmark"
import {
  buildInitialStreamEvent,
  buildStreamDeltaEvents,
  setupTimelineBenchmark,
  textPartID,
} from "./session-timeline-benchmark.fixture"
import { startTimelineProfile } from "./session-timeline-profile"
import {
  collectTimelineStreamMetrics,
  installTimelineStreamProbe,
  startTimelineStreamProbe,
} from "./session-timeline-stream-probe"

benchmark.describe("performance: session timeline streaming", () => {
  benchmark("streams assistant text without remounting or oscillating", async ({ page, report }) => {
    benchmark.setTimeout(Number(process.env.TIMELINE_COMPLETION_TIMEOUT_MS ?? 420_000) + 60_000)
    const result = await runTimelineStreamBenchmark(page)
    report(result.metrics, result.context)
  })
})

async function runTimelineStreamBenchmark(page: Page) {
  const completionTimeoutMs = Number(process.env.TIMELINE_COMPLETION_TIMEOUT_MS ?? 420_000)
  const cpuThrottle = Number(process.env.TIMELINE_CPU_THROTTLE ?? 30)
  const deltaCount = Number(process.env.TIMELINE_DELTA_COUNT ?? 160)
  const historyTurns = Number(process.env.TIMELINE_HISTORY_TURNS ?? 320)
  const eventBatch = Number(process.env.TIMELINE_EVENT_BATCH ?? 1)
  const minimal = process.env.TIMELINE_MINIMAL === "1"
  const profileCPU = process.env.TIMELINE_CPU_PROFILE === "1"
  const profileVisual = !minimal && profileCPU && process.env.TIMELINE_VISUAL_PROFILE !== "0"
  const fixture = await setupTimelineBenchmark(page, {
    historyTurns,
    eventBatch,
  })

  fixture.transport.enqueue(buildInitialStreamEvent(deltaCount))
  const contentStart = performance.now()
  await expect(fixture.text).toBeVisible()
  await expect(fixture.text).toContainText("Implementation plan")
  const initialContentObservedMs = performance.now() - contentStart
  await fixture.scrollToBottom()
  await fixture.waitForStableGeometry()

  const profile = await startTimelineProfile(page, { cpuThrottle, profileCPU })
  await installTimelineStreamProbe(page, { textPartID, finalIndex: deltaCount, profileVisual, minimal })
  const deltas = buildStreamDeltaEvents(deltaCount)
  await startTimelineStreamProbe(page)
  fixture.transport.enqueue(deltas)

  await page.waitForFunction(
    (finalIndex) =>
      (
        window as Window & {
          __timelineStreamBenchmark?: { applied: { index: number }[] }
        }
      ).__timelineStreamBenchmark?.applied.some((value) => value.index === finalIndex),
    deltaCount,
    { timeout: completionTimeoutMs },
  )
  await expect(fixture.text).toContainText("benchmark-complete")
  await expect(fixture.text).toContainText("Streaming")
  await fixture.waitForStableGeometry()
  const metrics = await collectTimelineStreamMetrics(page, {
    textPartID,
    finalIndex: deltaCount,
    navigations: benchmarkDiagnostics(page).navigations,
  })
  const delivered = deltas.length - fixture.transport.pendingCount()
  await profile.stop()

  const result = {
    metrics: {
      endToEndInitialContentObservedMs: initialContentObservedMs,
      ...metrics,
      deliveredDeltas: delivered,
      pendingDeltas: fixture.transport.pendingCount(),
    },
    context: {
      cpuThrottle,
      profileCPU,
      profileVisual,
      minimal,
      queuedDeltas: deltas.length,
      historyTurns,
      eventBatch,
    },
  }

  await profile.reset()
  return result
}
