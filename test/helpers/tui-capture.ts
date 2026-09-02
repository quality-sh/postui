import type { TestRendererSetup } from "@opentui/core/testing";

/** Minimal structural types for captured span frames (OpenTUI renderer output). */
type CapturedSpan = { text: string; fg: { equals(v: unknown): boolean } };
type CapturedLine = { spans: CapturedSpan[] };

/** Collapse a captured row's spans into plain text. */
function rowText(setup: TestRendererSetup, row: number): string {
  return (setup
    .captureSpans()
    .lines[row]?.spans.map((span: CapturedSpan) => span.text)
    .join("")) ?? "";
}

/** The whole captured frame, one terminal row per line. */
export function frameText(setup: TestRendererSetup, height: number): string {
  return Array.from({ length: height }, (_, row) => rowText(setup, row)).join("\n");
}

/** Every span in the frame, flattened. */
export function flatSpans(setup: TestRendererSetup): CapturedSpan[] {
  return setup.captureSpans().lines.flatMap((line: CapturedLine) => line.spans);
}

/** The joined text of the row containing `needle`, or null when absent. */
export function rowContaining(setup: TestRendererSetup, needle: string): string | null {
  const lines = setup.captureSpans().lines;
  for (const line of lines) {
    const text = line.spans.map((span: CapturedSpan) => span.text).join("");
    if (text.includes(needle)) return text;
  }
  return null;
}
