import { BoxRenderable, StyledText, TextRenderable, bold, fg } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import type { LoadedRequest } from "../gen/load.ts";
import { isMutatingMethod } from "./collection-groups.ts";
import { THEME } from "./theme.ts";

/** One text line plus the selection box's top/bottom border. */
export const REQUEST_ROW_HEIGHT = 3;
// Pane inner width 28 - marker (2) - method column (6), minus slack.
const MAX_NAME_CHARS = 18;
// The preview is a peek, not a pager: past this it says so instead of hiding.
const MAX_PREVIEW_LINES = 400;

/** The mockup's empty state, worded like the CLI's "nothing to generate" hint. */
export function renderEmptyState(renderer: CliRenderer, pane: BoxRenderable): void {
  const empty = new BoxRenderable(renderer, {
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
    width: "100%",
    height: "100%",
    gap: 1,
  });
  empty.add(
    new TextRenderable(renderer, {
      content: "no saved requests found",
      fg: THEME.color.text,
    }),
  );
  empty.add(
    new TextRenderable(renderer, { content: "in requests/", fg: THEME.color.text }),
  );
  empty.add(
    new TextRenderable(renderer, { content: "save one with", fg: THEME.color.dim }),
  );
  empty.add(
    new TextRenderable(renderer, { content: "postui save", fg: THEME.color.bright }),
  );
  pane.add(empty);
}

/** A failed workspace read renders as the named error it is — never a crash. */
export function renderError(renderer: CliRenderer, pane: BoxRenderable, error: unknown): void {
  const text = new TextRenderable(renderer, {
    content: namedErrorText(errorName(error), error),
    fg: THEME.color.text,
    wrapMode: "word",
    width: "100%",
  });
  pane.add(text);
}

function errorName(error: unknown): string {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    return String((error as { _tag: unknown })._tag);
  }
  return error instanceof Error ? error.name : "Error";
}

export function namedErrorText(name: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${name}: ${message}`;
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

/** Module names longer than the pane clip with an ellipsis; the preview shows the full module. */
function displayName(name: string): string {
  return name.length > MAX_NAME_CHARS ? `${name.slice(0, MAX_NAME_CHARS)}…` : name;
}

export function previewBox(renderer: CliRenderer, request: LoadedRequest): BoxRenderable {
  return new BoxRenderable(renderer, {
    flexGrow: 1,
    width: "100%",
    border: true,
    borderColor: THEME.color.border,
    title: `PREVIEW · ${request.name}.ts`,
    titleColor: THEME.color.bright,
    backgroundColor: THEME.color.bg,
  });
}

/** Past MAX_PREVIEW_LINES the preview says so instead of silently hiding the rest. */
export function previewText(content: string): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines.length <= MAX_PREVIEW_LINES) return lines.join("\n");
  return `${lines.slice(0, MAX_PREVIEW_LINES).join("\n")}\n… (${
    lines.length - MAX_PREVIEW_LINES
  } more lines — open the file)`;
}

export function clearChildren(box: BoxRenderable): void {
  // getChildren() returns a fresh array, so removal during iteration is safe.
  for (const child of box.getChildren()) box.remove(child);
}
