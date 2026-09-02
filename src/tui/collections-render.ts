import { BoxRenderable, StyledText, TextRenderable, bold, fg } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import type { LoadedRequest } from "../gen/load.ts";
import { isMutatingMethod } from "./collection-groups.ts";
import { errorName, namedErrorText, renderEmptyState } from "./render.ts";
import { THEME } from "./theme.ts";

/** One text line plus the selection box's top/bottom border. */
export const REQUEST_ROW_HEIGHT = 3;
// Pane inner width 28 - marker (2) - method column (6), minus slack.
const MAX_NAME_CHARS = 18;

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

/**
 * One request row: method badge plus module name. The selected row carries
 * the mockup's filled selection bar — a border in the accent color drawn
 * around the row (the same treatment panes use for focus) — with the "▶"
 * marker; at rest the border is painted in the background color so the
 * layout never shifts when the selection moves.
 */
export function requestRow(
  renderer: CliRenderer,
  request: LoadedRequest,
  selected: boolean,
): BoxRenderable {
  const row = new BoxRenderable(renderer, {
    width: "100%",
    height: REQUEST_ROW_HEIGHT,
    border: true,
    borderColor: selected ? THEME.color.accent : THEME.color.bg,
    backgroundColor: THEME.color.bg,
  });
  const method = request.request.method.toUpperCase();
  row.add(
    new TextRenderable(renderer, {
      content: new StyledText([
        fg(selected ? THEME.color.accent : THEME.color.bg)(selected ? "▶ " : "  "),
        bold(fg(isMutatingMethod(method) ? THEME.color.accent : THEME.color.dim)(
          method.padEnd(6),
        )),
        fg(selected ? THEME.color.bright : THEME.color.text)(displayName(request.name)),
      ]),
    }),
  );
  return row;
}

/** Module names longer than the pane clip with an ellipsis; the composer shows the full module. */
function displayName(name: string): string {
  return name.length > MAX_NAME_CHARS ? `${name.slice(0, MAX_NAME_CHARS)}…` : name;
}
