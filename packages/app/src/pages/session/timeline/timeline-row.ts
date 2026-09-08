import type { SnapshotFileDiff } from "@opencode-ai/sdk/v2"
import type { PartGroup } from "@opencode-ai/session-ui/message-part"
import type { CanvasReference } from "@opencode-ai/session-ui/context/canvas"
import { Data, Equal } from "effect"

export type SummaryDiff = SnapshotFileDiff & { file: string }

export namespace TimelineRow {
  export class TurnGap extends Data.TaggedClass("TurnGap")<{
    userMessageID: string
  }> {}
  export class CommentStrip extends Data.TaggedClass("CommentStrip")<{
    userMessageID: string
  }> {}
  export class UserMessage extends Data.TaggedClass("UserMessage")<{
    userMessageID: string
    anchor: boolean
  }> {}
  export class TurnDivider extends Data.TaggedClass("TurnDivider")<{
    userMessageID: string
    label: "compaction" | "interrupted"
  }> {}
  export class AssistantPart extends Data.TaggedClass("AssistantPart")<{
    userMessageID: string
    group: PartGroup
    previousAssistantPart: boolean
    canvases?: CanvasReference[]
  }> {}
  /** One virtual row: collapsed header + optional in-row process groups (tools/tasks). */
  export class ProcessSummary extends Data.TaggedClass("ProcessSummary")<{
    userMessageID: string
    durationMs?: number
    groups: PartGroup[]
    /** Compaction turns fold the whole summary, not only intermediate process. */
    kind?: "process" | "compaction"
  }> {}
  export class Thinking extends Data.TaggedClass("Thinking")<{
    userMessageID: string
    reasoningHeading?: string
  }> {}
  export class DiffSummary extends Data.TaggedClass("DiffSummary")<{
    userMessageID: string
    diffs: SummaryDiff[]
  }> {}
  /** 已完成画布的独立入口，不受过程折叠状态影响。 */
  export class CanvasSummary extends Data.TaggedClass("CanvasSummary")<{
    userMessageID: string
    sessionID: string
    canvases: CanvasReference[]
  }> {}
  export class Error extends Data.TaggedClass("Error")<{
    userMessageID: string
    text: string
  }> {}
  export class Retry extends Data.TaggedClass("Retry")<{
    userMessageID: string
  }> {}

  export type TimelineRow =
    | TurnGap
    | CommentStrip
    | UserMessage
    | TurnDivider
    | AssistantPart
    | ProcessSummary
    | Thinking
    | DiffSummary
    | CanvasSummary
    | Error
    | Retry

  export const key = (row: TimelineRow) => {
    switch (row._tag) {
      case "TurnGap":
        return `turn-gap:${row.userMessageID}`
      case "CommentStrip":
        return `comment-strip:${row.userMessageID}`
      case "UserMessage":
        return `user-message:${row.userMessageID}`
      case "TurnDivider":
        return `turn-divider:${row.userMessageID}:${row.label}`
      case "AssistantPart":
        return `assistant-part:${row.userMessageID}:${row.group.key}`
      case "ProcessSummary":
        return `process-summary:${row.userMessageID}`
      case "Thinking":
        return `thinking:${row.userMessageID}`
      case "DiffSummary":
        return `diff-summary:${row.userMessageID}`
      case "CanvasSummary":
        return `canvas-summary:${row.userMessageID}`
      case "Error":
        return `error:${row.userMessageID}`
      case "Retry":
        return `retry:${row.userMessageID}`
    }
  }

  export function equals(a: TimelineRow, b: TimelineRow) {
    return Equal.equals(a, b)
  }
}
