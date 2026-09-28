import { extractEnvRefs } from "../save/credentials.ts";
import { REDACTED, isCredentialHeader } from "../send/redact.ts";
import { bodySpans } from "./composer-body.ts";
import { tableSource } from "./composer-editor.ts";
import type { EditorState } from "./composer-editor.ts";
import type { RequestDraft } from "./composer-send.ts";
import { sliceSpans, span, withCursor } from "./composer-spans.ts";
import type { ContentLine, Span } from "./composer-spans.ts";
import type { Row, TableCursor } from "./composer-table.ts";
import { lineOf, windowAround } from "./composer-text.ts";
import { THEME } from "./theme.ts";

/**
 * The composer's tab content as lines of spans: the line-numbered body
 * editor and the PARAMS/HEADERS/AUTH row tables. composer-render.ts turns
 * them into renderables (or develops them in).
 *
 * The body editor matches the response code block: line numbers on an
 * `element` gutter, the text on the pane's panel, no rule between, JSON
 * coloured by token kind (composer-body.ts) — while the text itself stays
 * exactly as typed, so the cursor lands where the keys put it.
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

const plain = (text: string, color: string): ContentLine => ({ spans: [span(text, color)] });

export function contentLines(view: ContentView): ContentLine[] {
  const draft = view.editor.draft as RequestDraft;
  if (view.editor.tab === "body") return bodyView(draft, view);
  const lines = tableView(view);
  if (view.editor.tab === "auth") {
    lines.push(plain("  values must be env references, e.g. Bearer $API_TOKEN", THEME.color.muted));
  }
  return lines;
}

function bodyView(draft: RequestDraft, view: ContentView): ContentLine[] {
  if (Array.isArray(draft.body)) {
    return [
      ...draft.body.map(entry => {
        const value = entry.file === undefined ? (entry.value ?? "") : `@${entry.file}`;
        return plain(`  ${entry.name} = ${value}`, THEME.color.text);
      }),
      plain("  form bodies are edited in the saved module", THEME.color.muted),
    ];
  }
  const text = draft.body ?? "";
  if (text === "" && !view.active) return [plain("  (no body)", THEME.color.dim)];
  const lines = bodySpans(text);
  const cursor = view.editor.bodyCursor;
  const cursorLine = lineOf(text, cursor);
  const top = scrollTop(view, cursorLine, lines.length);
  const gutterWidth = String(lines.length).length;
  // One horizontal offset for every line, chosen so the cursor stays in view.
  const lineStartAt = text.lastIndexOf("\n", cursor - 1) + 1;
  const textWidth = view.width - gutterWidth - 3;
  const column = cursor - lineStartAt;
  const rawLine = text.split("\n")[cursorLine] ?? "";
  const offset = column - windowAround(rawLine, column, textWidth).cursor;
  const shown = lines.slice(top, top + Math.min(view.visibleLines, lines.length));
  return shown.map((spans, index) => {
    const number = top + index;
    const visible = sliceSpans(spans, offset);
    const body = view.active && number === cursorLine ? withCursor(visible, column - offset) : visible;
    return {
      spans: [
        // The gutter: the number on the element tone, then one panel cell.
        { text: ` ${String(number + 1).padStart(gutterWidth, " ")} `, fg: THEME.color.dim, bg: THEME.color.element },
        span(" ", THEME.color.text),
        ...body,
      ],
    };
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

function tableView(view: ContentView): ContentLine[] {
  const source = tableSource(view.editor);
  if (source === null) return [];
  const tab = view.editor.tab;
  const separator = tab === "params" ? " = " : ": ";
  const cursor = view.active ? view.editor.table : null;
  const lines: ContentLine[] = source.rows.map((row, index) => {
    const at = cursor !== null && cursor.row === index ? cursor : null;
    return { spans: tableRow(row, at, separator, tab !== "params"), row: index };
  });
  const addRow = source.rows.length;
  if (cursor !== null && cursor.row >= addRow) {
    lines.push({ spans: tableRow(source.template, cursor, separator, tab !== "params"), row: addRow });
  } else {
    lines.push({ spans: [span(`  ${ADD_LABELS[tab] ?? "+ add"}`, THEME.color.dim)], row: addRow });
  }
  return lines;
}

/** Cell text as spans, with the cursor when it sits in this cell. */
function cell(text: string, pos: number | null): Span[] {
  const spans = [span(text, THEME.color.text)];
  return pos === null ? spans : withCursor(spans, pos);
}

/** One name/value row; `cursor` is set only on the row the cursor is in. */
function tableRow(row: Row, cursor: TableCursor | null, separator: string, isHeader: boolean): Span[] {
  const [name, value] = row;
  const marker = cursor === null ? span("  ", THEME.color.text) : span("▸ ", THEME.color.accent);
  const nameSpans = cell(name, cursor?.col === 0 ? cursor.pos : null);
  const credential = isHeader && isCredentialHeader(name);
  let valueSpans: Span[];
  if (cursor?.col === 1) valueSpans = cell(credential ? maskCredential(value) : value, cursor.pos);
  else valueSpans = credential ? redactedValue(value) : [span(value, THEME.color.text)];
  return [marker, ...nameSpans, span(separator, THEME.color.dim), ...valueSpans];
}

/** A credential value at rest: the fixed marker, the env names it uses, or a warning. */
function redactedValue(value: string): Span[] {
  if (value === "") return [span("(empty)", THEME.color.dim)];
  const refs = extractEnvRefs(value);
  if (refs.length > 0) {
    return [span(REDACTED, THEME.color.text), span(` ← ${refs.map(ref => `$${ref}`).join(" ")}`, THEME.color.muted)];
  }
  return [span(REDACTED, THEME.color.text), span(" literal — will not save", THEME.color.gold)];
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
