import { StyledText, TextRenderable, bold, fg } from "@opentui/core";
import type { BoxRenderable, CliRenderer } from "@opentui/core";
import type { LoadedRequest } from "../gen/load.ts";
import type { FlatRow } from "./collections-rows.ts";
import { errorName, namedErrorText, renderEmptyState } from "./render.ts";
import { THEME, methodColor } from "./theme.ts";

/**
 * Every request row is one terminal row, selected or not: the selection is
 * a bar and a fill, never a box, so the layout never shifts when the
 * selection moves and the pane's window math stays one constant.
 */
export const REQUEST_ROW_HEIGHT = 1;
// Pane inner width 28 - bar column (1) - guide (2) - method column (6)
// leaves 19 cells: 18 name characters plus the ellipsis.
const MAX_NAME_CHARS = 18;

/**
 * Where a request row sits under its collection header: `middle` rows draw
 * `├` and carry the guide on down, the `last` row closes it with `└`, and
 * `none` (the flat search-match list, which has no headers) draws no guide.
 */
export type TreeBranch = "middle" | "last" | "none";

/**
 * The branch for the flattened row at `rowIndex`: `last` when no request of
 * the same group follows it, `none` when the layout has no group headers at
 * all. Pure over the pane's row layout.
 */
export function treeBranch(rows: readonly FlatRow[], rowIndex: number): TreeBranch {
  if (!rows.some(row => row.kind === "header")) return "none";
  return rows[rowIndex + 1]?.kind === "request" ? "middle" : "last";
}

/**
 * The pane's empty state, in the one shared style: what is missing plus the
 * way out, worded like the CLI's "nothing to generate" hint. The halftone
 * decoration comes along — this is the mockup's dotted left rail.
 */
export function renderCollectionsEmptyState(renderer: CliRenderer, pane: BoxRenderable): void {
  renderEmptyState(
    renderer,
    pane,
    [
      { text: "no saved requests found", tone: "message" },
      { text: "in requests/", tone: "message" },
      { text: "save one with", tone: "hint" },
      { text: "postui save", tone: "command" },
    ],
    { decor: true },
  );
}

/** The filter found nothing: same style, honest wording, no fake results. */
export function renderNoMatches(
  renderer: CliRenderer,
  pane: BoxRenderable,
  query: string,
): void {
  renderEmptyState(
    renderer,
    pane,
    [
      { text: `no matches for "${query}"`, tone: "message" },
      { text: "esc goes back to browsing", tone: "hint" },
    ],
    { decor: true },
  );
}

/** A failed workspace read renders as the named error it is — never a crash. */
export function renderError(renderer: CliRenderer, pane: BoxRenderable, error: unknown): void {
  pane.add(
    new TextRenderable(renderer, {
      content: new StyledText([
        bold(fg(THEME.color.love)("✗ ")),
        fg(THEME.color.text)(namedErrorText(errorName(error), error)),
      ]),
      wrapMode: "word",
      width: "100%",
    }),
  );
}

/** One coloured run of a row's text: rows are built as spans, then styled or developed. */
export interface RowSpan {
  readonly text: string;
  readonly fg: string;
  readonly bold?: boolean;
}

/** Spans → the StyledText a row's TextRenderable shows. */
export function styledSpans(spans: readonly RowSpan[]): StyledText {
  return new StyledText(
    spans.map(span => (span.bold === true ? bold(fg(span.fg)(span.text)) : fg(span.fg)(span.text))),
  );
}

/** Collection header: the mockup's "▾ Users" line. */
export function headerSpans(title: string): RowSpan[] {
  return [
    { text: "▾ ", fg: THEME.color.dim },
    { text: title, fg: THEME.color.text, bold: true },
  ];
}

/** The guide glyph of one row, left of its method badge. */
const GUIDES: Record<TreeBranch, string> = { middle: "├ ", last: "└ ", none: "  " };

/**
 * One request row's text: bar column, the collection's tree guide (`├` /
 * `└`), method badge, name. The SELECTED row carries the `▌` bar in its
 * first column (accent, or `bar` while a pulse runs); every other row
 * leaves that column blank. Badges take their method's color (theme.ts
 * methodColor). The accent-soft fill under a selected row is the row box's
 * background, not part of the text (collections-slot.ts).
 */
export function requestSpans(
  request: LoadedRequest,
  branch: TreeBranch,
  selected: boolean,
  bar: string = THEME.color.accent,
): RowSpan[] {
  const method = request.request.method.toUpperCase();
  return [
    selected ? { text: "▌", fg: bar, bold: true } : { text: " ", fg: THEME.color.border },
    { text: GUIDES[branch], fg: THEME.color.border },
    { text: methodBadge(method).padEnd(BADGE_WIDTH), fg: methodColor(method), bold: true },
    { text: displayName(request.name), fg: THEME.color.text, bold: selected },
  ];
}

/** The method column: the longest badge (PATCH) plus one space. */
const BADGE_WIDTH = 6;

/**
 * The badge text: DELETE and OPTIONS shorten the way Postman's sidebar
 * does (DEL, OPT), so every badge leaves a space before the name.
 */
export function methodBadge(method: string): string {
  if (method === "DELETE") return "DEL";
  if (method === "OPTIONS") return "OPT";
  return method;
}

/** Module names longer than the pane clip with an ellipsis; the composer shows the full module. */
function displayName(name: string): string {
  return name.length > MAX_NAME_CHARS ? `${name.slice(0, MAX_NAME_CHARS)}…` : name;
}
