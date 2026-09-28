import { BoxRenderable } from "@opentui/core";
import type { CliRenderer, Renderable } from "@opentui/core";
import type { ComposerFx } from "./composer-fx.ts";
import { lineText } from "./composer-spans.ts";
import type { ContentLine } from "./composer-spans.ts";
import { cellsFromSpans, developLines } from "./fx/develop.ts";

/**
 * Tab content lines → renderables. Table rows sit on their own one-row
 * boxes so hover, focus and pulses can fill them; while a develop reveal
 * runs, the whole content (a tab switch) or one row (a new row) is the
 * develop renderable instead, and the next rebuild swaps the real lines
 * back in (the reveal carries fg only: no cursor block, no gutter fill).
 */

/** How long a tab's content takes to develop in: short, it is a switch, not a load. */
const DEVELOP_MS = 150;

type Develop = Renderable & { finish(): void };

/** A develop reveal in progress: the whole tab content, or one table row. */
export interface DevelopPart {
  readonly target: "content" | number;
  /** Built on the first render that shows it, then kept across rebuilds. */
  instance: Develop | null;
  readonly onDone: () => void;
}

/**
 * Renderables that outlive a rebuild: the pane detaches them before it
 * clears and the next render re-adds them, so the spinner never restarts
 * and a reveal runs to its end.
 */
export interface LiveParts {
  spinner: Renderable | null;
  develop: DevelopPart | null;
}

export interface MountOptions {
  readonly fx: ComposerFx;
  readonly live: LiveParts;
  readonly hoverable: (box: BoxRenderable, target: string) => void;
  /** A table row's fill when no pulse runs on it. */
  readonly rowRest: (row: number) => string;
}

function developOf(renderer: CliRenderer, part: DevelopPart, lines: readonly ContentLine[]): Develop {
  part.instance ??= developLines(renderer, cellsFromSpans(lines.map(line => line.spans)), {
    durationMs: DEVELOP_MS,
    onDone: part.onDone,
  });
  return part.instance;
}

export function mountContent(
  renderer: CliRenderer,
  box: BoxRenderable,
  lines: readonly ContentLine[],
  opts: MountOptions,
): void {
  const develop = opts.live.develop;
  if (develop?.target === "content") {
    box.add(developOf(renderer, develop, lines));
    return;
  }
  for (const line of lines) {
    if (line.row === undefined) {
      box.add(lineText(renderer, line.spans));
      continue;
    }
    const row = line.row;
    const target = `row:${row}`;
    const rowBox = new BoxRenderable(renderer, { width: "100%", height: 1, flexShrink: 0 });
    opts.fx.bind(target, () => opts.rowRest(row), color => {
      rowBox.backgroundColor = color;
    });
    opts.hoverable(rowBox, target);
    rowBox.add(develop?.target === row ? developOf(renderer, develop, [line]) : lineText(renderer, line.spans));
    box.add(rowBox);
  }
}

/** Take the live parts out of the tree before a rebuild destroys it. */
export function detachLive(live: LiveParts): void {
  for (const part of [live.spinner, live.develop?.instance ?? null]) {
    if (part !== null && !part.isDestroyed) part.parent?.remove(part);
  }
}
