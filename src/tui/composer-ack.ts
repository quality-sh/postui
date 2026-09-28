import { tableSource } from "./composer-editor.ts";
import type { ComposerField, ComposerTab, EditorState } from "./composer-editor.ts";
import type { ComposerFx } from "./composer-fx.ts";
import type { ComposerKey } from "./composer-text.ts";
import { blendHex } from "./motion.ts";
import { THEME, methodColor } from "./theme.ts";

/**
 * What each composer key shows besides its result: the input rule
 * (rule_tui_input_acknowledged) says a key that changes something must
 * visibly land even when the new frame looks like the old one. The pane
 * snapshots the editor before a key and hands both states here; the
 * differences become fx pulses and, for a tab switch or a new row, a
 * develop reveal.
 *
 * - method cycled: the pill swells toward the new method's colour and the
 *   name blooms from fog into it;
 * - tab switched: the accent pill hands over from the old tab to the new
 *   one and the content develops in;
 * - focus moved (field, or table row): the new fill sweeps in, the old
 *   one sweeps out;
 * - row added: the row swells and develops in; row removed (or ctrl+d on
 *   nothing): the slot it left pulses.
 */

export interface EditorSnapshot {
  readonly field: ComposerField;
  readonly tab: ComposerTab;
  readonly method: string;
  /** Rows of the current tab's table; null on BODY. */
  readonly rows: number | null;
  readonly row: number;
}

/** What a key asks the rebuild for: a develop reveal of the content or one row. */
export type RevealTarget = "content" | number | null;

/** Focus sweeps are decoration on a state that persists: quicker than an acknowledgement. */
const FOCUS_MS = 200;

const ROW_ADDED = blendHex(THEME.color.accentSoft, THEME.color.accent, 0.35);

export function snapshotOf(editor: EditorState): EditorSnapshot {
  return {
    field: editor.field,
    tab: editor.tab,
    method: editor.draft?.method.toUpperCase() ?? "",
    rows: tableSource(editor)?.rows.length ?? null,
    row: editor.table.row,
  };
}

/** The fx target a field's fill lives on. */
function fieldTarget(editor: EditorState, field: ComposerField): string | null {
  if (field === "method" || field === "url") return field;
  if (field === "tabs") return `tab:${editor.tab}`;
  return editor.tab === "body" ? null : `row:${editor.table.row}`;
}

/** The fill a field's target leaves behind when focus moves off it. */
const FIELD_FILL: Record<ComposerField, string> = {
  method: THEME.color.accentSoft,
  url: THEME.color.accentSoft,
  tabs: THEME.color.accent,
  content: THEME.color.accentSoft,
};

/** The fill a field's target sweeps in from when focus lands on it. */
const FIELD_FROM: Record<ComposerField, string> = {
  method: THEME.color.element,
  url: THEME.color.element,
  tabs: THEME.color.accentSoft,
  content: THEME.color.panel,
};

/** Sweep the newly focused field's fill in (pane focus arriving, or a field move). */
export function sweepFocusIn(fx: ComposerFx, editor: EditorState): void {
  const target = fieldTarget(editor, editor.field);
  if (target !== null) fx.pulse(target, FIELD_FROM[editor.field], { durationMs: FOCUS_MS });
}

export function acknowledgeKey(fx: ComposerFx, before: EditorSnapshot, editor: EditorState, key: ComposerKey): RevealTarget {
  const after = snapshotOf(editor);
  if (after.method !== before.method) {
    fx.pulse("method", blendHex(THEME.color.element, methodColor(after.method), 0.45), { shape: "swell" });
    fx.pulse("method:label", THEME.color.fog);
  }
  if (after.tab !== before.tab) {
    fx.pulse(`tab:${before.tab}`, THEME.color.accent, { durationMs: FOCUS_MS });
    fx.pulse(`tab:${after.tab}`, THEME.color.accentSoft, { durationMs: FOCUS_MS });
    return "content";
  }
  if (after.field !== before.field) {
    // The tab and the table row are unchanged here, so the old field's target resolves as before the key.
    const old = fieldTarget(editor, before.field);
    if (old !== null) fx.pulse(old, FIELD_FILL[before.field], { durationMs: FOCUS_MS });
    sweepFocusIn(fx, editor);
    return null;
  }
  if (after.field !== "content" || after.rows === null || before.rows === null) return null;
  return acknowledgeRows(fx, before, after, key);
}

function acknowledgeRows(fx: ComposerFx, before: EditorSnapshot, after: EditorSnapshot, key: ComposerKey): RevealTarget {
  const rows = after.rows ?? 0;
  const had = before.rows ?? 0;
  if (rows > had) {
    fx.pulse(`row:${rows - 1}`, ROW_ADDED, { shape: "swell" });
    return rows - 1;
  }
  if (rows < had || (key.ctrl && key.name === "d")) {
    // The slot the row left (or ctrl+d's row, when there was nothing to drop).
    fx.pulse(`row:${before.row}`, THEME.color.fog, { shape: "swell" });
    return null;
  }
  if (after.row !== before.row) {
    fx.pulse(`row:${before.row}`, THEME.color.accentSoft, { durationMs: FOCUS_MS });
    fx.pulse(`row:${after.row}`, THEME.color.panel, { durationMs: FOCUS_MS });
  }
  return null;
}
