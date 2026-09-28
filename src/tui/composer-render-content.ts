import { StyledText, TextRenderable, bg, fg } from "@opentui/core";
import type { BoxRenderable, CliRenderer, TextChunk } from "@opentui/core";
import { extractEnvRefs } from "../save/credentials.ts";
import { REDACTED, isCredentialHeader } from "../send/redact.ts";
import { tableSource } from "./composer-editor.ts";
import type { EditorState } from "./composer-editor.ts";
import type { RequestDraft } from "./composer-send.ts";
import type { Row, TableCursor } from "./composer-table.ts";
import { lineOf, windowAround } from "./composer-text.ts";
import { THEME } from "./theme.ts";

/**
 * The composer's tab content: the line-numbered body editor and the
 * PARAMS/HEADERS/AUTH row tables.
 *
 * REDACTION: a credential header's value (the pipeline's own
 * isCredentialHeader) is never drawn as text. At rest it renders as the
 * fixed [redacted] marker plus the env names it references — names are
 * safe, values resolve only at send time (rule_env_resolve_at_send). While
 * the cursor is in the value, env references stay readable and every other
 * character shows as •, so a typed `$API_TOKEN` can be checked but a pasted
 * literal secret never appears on screen.
 */

export interface ContentView {
  readonly editor: EditorState;
  /** The content field has the keys (draws the cursor). */
  readonly active: boolean;
  readonly scroll: { bodyTop: number };
  readonly visibleLines: number;
  /** Inner width of the pane, for horizontal scrolling of the body. */
  readonly width: number;
}

const ADD_LABELS: Record<string, string> = {
  params: "+ add param",
  headers: "+ add header",
  auth: "+ add credential header",
};

/** Text with a block cursor at `cursor` (a space when the cursor is past the end). */
export function cursorChunks(text: string, cursor: number, color: string): TextChunk[] {
  const at = text.codePointAt(cursor);
  const glyph = at === undefined ? " " : String.fromCodePoint(at);
  return [
    fg(color)(text.slice(0, cursor)),
    bg(THEME.color.accent)(fg(THEME.color.bg)(glyph)),
    fg(color)(text.slice(cursor + glyph.length)),
  ];
}

export function renderContent(renderer: CliRenderer, box: BoxRenderable, view: ContentView): void {
  const draft = view.editor.draft as RequestDraft;
  if (view.editor.tab === "body") {
    bodyView(renderer, box, draft, view);
    return;
  }
  tableView(renderer, box, view);
  if (view.editor.tab === "auth") {
    box.add(line(renderer, [fg(THEME.color.dim)("  values must be env references, e.g. Bearer $API_TOKEN")]));
  }
}

function line(renderer: CliRenderer, chunks: TextChunk[]): TextRenderable {
  return new TextRenderable(renderer, { content: new StyledText(chunks), width: "100%", wrapMode: "none" });
}

function bodyView(renderer: CliRenderer, box: BoxRenderable, draft: RequestDraft, view: ContentView): void {
  if (Array.isArray(draft.body)) {
    for (const entry of draft.body) {
      const value = entry.file === undefined ? (entry.value ?? "") : `@${entry.file}`;
      box.add(line(renderer, [fg(THEME.color.text)(`  ${entry.name} = ${value}`)]));
    }
    box.add(line(renderer, [fg(THEME.color.dim)("  form bodies are edited in the saved module")]));
    return;
  }
  const text = draft.body ?? "";
  if (text === "" && !view.active) {
    box.add(line(renderer, [fg(THEME.color.text)("  (no body)")]));
    return;
  }
  const lines = text.split("\n");
  const cursor = view.editor.bodyCursor;
  const cursorLine = lineOf(text, cursor);
  const top = scrollTop(view, cursorLine, lines.length);
  const gutterWidth = String(lines.length).length;
  // One horizontal offset for every line, chosen so the cursor stays in view.
  const lineStartAt = text.lastIndexOf("\n", cursor - 1) + 1;
  const textWidth = view.width - gutterWidth - 3;
  const column = cursor - lineStartAt;
  const offset = column - windowAround(lines[cursorLine] ?? "", column, textWidth).cursor;
  const shown = lines.slice(top, top + Math.min(view.visibleLines, lines.length));
  shown.forEach((content, index) => {
    const number = top + index;
    const gutter = fg(THEME.color.dim)(`${String(number + 1).padStart(gutterWidth, " ")} │ `);
    const visible = content.slice(offset);
    const body = view.active && number === cursorLine
      ? cursorChunks(visible, column - offset, THEME.color.bright)
      : [fg(THEME.color.text)(visible === "" ? " " : visible)];
    box.add(line(renderer, [gutter, ...body]));
  });
}

/** Keep the cursor line inside the window, moving the window as little as possible. */
function scrollTop(view: ContentView, cursorLine: number, lineCount: number): number {
  const visible = Math.min(view.visibleLines, lineCount);
  let top = Math.min(view.scroll.bodyTop, Math.max(0, lineCount - visible));
  if (view.active) {
    if (cursorLine < top) top = cursorLine;
    if (cursorLine >= top + visible) top = cursorLine - visible + 1;
  }
  view.scroll.bodyTop = top;
  return top;
}

function tableView(renderer: CliRenderer, box: BoxRenderable, view: ContentView): void {
  const source = tableSource(view.editor);
  if (source === null) return;
  const tab = view.editor.tab;
  const separator = tab === "params" ? " = " : ": ";
  const cursor = view.active ? view.editor.table : null;
  source.rows.forEach((row, index) => {
    const at = cursor !== null && cursor.row === index ? cursor : null;
    box.add(tableRow(renderer, row, at, separator, tab !== "params"));
  });
  if (cursor !== null && cursor.row >= source.rows.length) {
    box.add(tableRow(renderer, source.template, cursor, separator, tab !== "params"));
  } else {
    box.add(line(renderer, [fg(THEME.color.dim)(`  ${ADD_LABELS[tab] ?? "+ add"}`)]));
  }
}

/** One name/value row; `cursor` is set only on the row the cursor is in. */
function tableRow(
  renderer: CliRenderer,
  row: Row,
  cursor: TableCursor | null,
  separator: string,
  isHeader: boolean,
): TextRenderable {
  const [name, value] = row;
  const marker = cursor === null ? fg(THEME.color.text)("  ") : fg(THEME.color.accent)("▸ ");
  const nameChunks = cursor?.col === 0
    ? cursorChunks(name, cursor.pos, THEME.color.bright)
    : [fg(THEME.color.text)(name)];
  const credential = isHeader && isCredentialHeader(name);
  let valueChunks: TextChunk[];
  if (cursor?.col === 1) {
    valueChunks = cursorChunks(credential ? maskCredential(value) : value, cursor.pos, THEME.color.bright);
  } else {
    valueChunks = credential ? redactedValue(value) : [fg(THEME.color.text)(value)];
  }
  return line(renderer, [marker, ...nameChunks, fg(THEME.color.dim)(separator), ...valueChunks]);
}

/** A credential value at rest: the fixed marker, the env names it uses, or a warning. */
function redactedValue(value: string): TextChunk[] {
  if (value === "") return [fg(THEME.color.dim)("(empty)")];
  const refs = extractEnvRefs(value);
  if (refs.length > 0) {
    return [fg(THEME.color.text)(REDACTED), fg(THEME.color.dim)(` ← ${refs.map(ref => `$${ref}`).join(" ")}`)];
  }
  return [fg(THEME.color.text)(REDACTED), fg(THEME.color.accent)(" literal — will not save")];
}

/**
 * The value with env references kept and everything else masked. Same
 * length as the input, so the cursor offset needs no mapping. References
 * are found with the save module's own parser (extractEnvRefs).
 */
export function maskCredential(value: string): string {
  let out = "";
  let at = 0;
  while (at < value.length) {
    const ref = envRefLengthAt(value, at);
    if (ref > 0) {
      out += value.slice(at, at + ref);
      at += ref;
    } else {
      out += value[at] === " " ? " " : "•";
      at += 1;
    }
  }
  return out;
}

/** Length of the `$NAME` / `${NAME}` reference starting at `at`, or 0. */
function envRefLengthAt(text: string, at: number): number {
  if (text[at] !== "$") return 0;
  const name = extractEnvRefs(text.slice(at))[0];
  if (name === undefined) return 0;
  if (text.startsWith(`\${${name}}`, at)) return name.length + 3;
  return text.startsWith(`$${name}`, at) ? name.length + 1 : 0;
}
