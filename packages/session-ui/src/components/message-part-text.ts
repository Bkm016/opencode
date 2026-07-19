export function readPartText(accum: Record<string, string> | undefined, part: { id: string; text?: string }): string {
  return (accum?.[part.id] ?? part.text ?? "").trim()
}

export function isLastTextualPart(
  parts: readonly { id: string; type: string; text?: string }[],
  id: string,
  type: "text" | "reasoning",
) {
  return parts.filter((part) => part.type === type && !!part.text?.trim()).at(-1)?.id === id
}
