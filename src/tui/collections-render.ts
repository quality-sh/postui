import { BoxRenderable, StyledText, TextRenderable, bold, fg } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import type { LoadedRequest } from "../gen/load.ts";
import { isMutatingMethod } from "./collection-groups.ts";
import type { FlatRow } from "./collections-rows.ts";
import { errorName, namedErrorText, renderEmptyState } from "./render.ts";
import { THEME } from "./theme.ts";

/**
 * Every request row is three terminal rows tall — the selection box's
 * border plus its text — selected or not, so the layout never shifts when
 * the selection moves and the pane's window math stays one constant.
 * Unselected rows spend the extra rows on the tree guide.
 */
export const REQUEST_ROW_HEIGHT = 3;
// Inside the selection box: pane inner width 28 - marker column (1) - box
// borders (2) - padding (1) - method column (6) leaves 18 cells, the
// ellipsis included.
const MAX_NAME_CHARS = 17;

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
      { text: "no saved requests found", tone: "text" },
      { text: "in requests/", tone: "text" },
      { text: "save one with", tone: "dim" },
      { text: "postui save", tone: "bright" },
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
      { text: `no matches for "${query}"`, tone: "text" },
      { text: "esc goes back to browsing", tone: "dim" },
    ],
    { decor: true },
  );
}

/** A failed workspace read renders as the named error it is — never a crash. */
export function renderError(renderer: CliRenderer, pane: BoxRenderable, error: unknown): void {
  pane.add(
    new TextRenderable(renderer, {
      content: new StyledText([
        bold(fg(THEME.color.accent)("✗ ")),
        fg(THEME.color.text)(namedErrorText(errorName(error), error)),
      ]),
      wrapMode: "word",
      width: "100%",
    }),
  );
}

/** Collection header: the mockup's "▾ Users" line. */
export function headerRow(renderer: CliRenderer, title: string): TextRenderable {
  return new TextRenderable(renderer, {
    content: new StyledText([fg(THEME.color.dim)("▾ "), bold(fg(THEME.color.bright)(title))]),
  });
}

/** The guide glyphs of one unselected row's three terminal rows. */
const GUIDES: Record<TreeBranch, { readonly above: string; readonly at: string; readonly below: string }> = {
  middle: { above: "│", at: "├ ", below: "│" },
  last: { above: "│", at: "└ ", below: " " },
  none: { above: " ", at: "  ", below: " " },
};

/**
 * One request row, per the mockup: only the SELECTED row is boxed — an
 * accent border around method badge and name, with the "▶" marker outside
 * the box on its left — while every other row is drawn plain, hanging off
 * the collection's tree guide (`├` / `└`) in the box's left-border column.
 * The selected row's box is the returned renderable, so the pane's border
 * sweep lands on it. Methods keep their colors: mutating ones in the
 * accent, safe ones green.
 *
 * With `onSelect`, a left click anywhere on the row selects it (the event
 * bubbles from the row's text up to this box, so the whole 3-row strip is
 * the click target) — the same highlight move j/k performs, nothing more.
 */
export function requestRow(
  renderer: CliRenderer,
  request: LoadedRequest,
  selected: boolean,
  onSelect?: (request: LoadedRequest) => void,
  branch: TreeBranch = "middle",
): BoxRenderable {
  // One column in from the pane edge: the marker column, left of the box.
  // (OpenTUI turns the border on whenever a border color is given, so the
  // color goes to the selected row only.)
  const row = new BoxRenderable(renderer, {
    height: REQUEST_ROW_HEIGHT,
    marginLeft: 1,
    backgroundColor: THEME.color.bg,
    ...(selected ? { border: true, borderColor: THEME.color.accent } : {}),
  });
  if (onSelect !== undefined) {
    row.onMouseDown = (event) => {
      if (event.type !== "down" || event.button !== 0) return;
      onSelect(request);
    };
  }
  const method = request.request.method.toUpperCase();
  const label = [
    bold(fg(isMutatingMethod(method) ? THEME.color.accent : THEME.color.safe)(method.padEnd(6))),
    fg(selected ? THEME.color.bright : THEME.color.text)(displayName(request.name)),
  ];
  if (selected) {
    // The leading space lines the badge up with the unselected rows' badges.
    row.add(new TextRenderable(renderer, { content: new StyledText([fg(THEME.color.bg)(" "), ...label]) }));
    // The marker sits in the margin column, on the text row: positioned
    // out of the box (the pane does not clip overflow).
    row.add(
      new TextRenderable(renderer, {
        content: new StyledText([bold(fg(THEME.color.accent)("▶"))]),
        position: "absolute",
        left: -2,
        top: 0,
      }),
    );
    return row;
  }
  // The guide runs through all three rows: in from above, the branch at the
  // label, and on down to the next sibling unless this row closes the group.
  const guide = GUIDES[branch];
  row.add(
    new TextRenderable(renderer, {
      content: new StyledText([
        fg(THEME.color.border)(`${guide.above}\n${guide.at}`),
        ...label,
        fg(THEME.color.border)(`\n${guide.below}`),
      ]),
    }),
  );
  return row;
}

/** Module names longer than the pane clip with an ellipsis; the composer shows the full module. */
function displayName(name: string): string {
  return name.length > MAX_NAME_CHARS ? `${name.slice(0, MAX_NAME_CHARS)}…` : name;
}
