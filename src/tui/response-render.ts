import { BoxRenderable, ScrollBoxRenderable, StyledText, TextRenderable, bold, fg } from "@opentui/core";
import type { CliRenderer, Renderable, TextChunk } from "@opentui/core";
import { scrubSecrets } from "../send/redact.ts";
import type { SendResult } from "../send/send.ts";
import { codeBlock, developingCodeBlock } from "./code-block.ts";
import { skeletonLines } from "./fx/skeleton.ts";
import { highlightJson } from "./json-highlight.ts";
import type { HighlightedJson } from "./json-highlight.ts";
import { errorLine, emptyStateBox, tabsRow } from "./render.ts";
import { busyHeader, errorChunks, formatBytes, resultChunks } from "./response-header.ts";
import type { BusyHeader, SendStamp, SendTicket } from "./response-header.ts";
import { developTexts } from "./response-reveal.ts";
import { THEME } from "./theme.ts";

/**
 * Response pane rendering: the mockup's status line (status code colored —
 * sage for success, love for 4xx/5xx and failed sends — plus latency and
 * size, stamped `#N · HH:MM:SS`), BODY/HEADERS/TESTS tabs, the body as
 * pretty-printed, colored JSON in a line-numbered block, and the
 * diagnostic region. While a send runs: a busy header and skeleton fog.
 * A fresh result (or error) develops in from halftone fog when asked to.
 *
 * REDACTION: every text derived from a send is scrubbed against that send's
 * resolved env values before it is placed in the pane — the same final pass
 * renderDigest() does on the CLI, applied on every path, with no option to
 * skip it (rule_redaction_no_off_switch). Header credential values are
 * already replaced with the fixed marker (REDACTED) by the pipeline's
 * capture. The develop reveal draws exactly the scrubbed text it is given.
 */

export interface ResponseRenderState {
  readonly tab: "body" | "headers" | "tests";
  readonly bodyWindow: number;
  readonly view:
    | { readonly kind: "idle" }
    | { readonly kind: "sending"; readonly ticket: SendTicket }
    | {
        readonly kind: "result";
        readonly result: SendResult;
        readonly latencyMs: number;
        readonly extraSecrets: string[];
        readonly forName: string;
        readonly stamp: SendStamp | null;
      }
    | { readonly kind: "error"; readonly error: unknown; readonly stamp: SendStamp | null };
  readonly note: string | null;
  readonly requestName: string | null;
  readonly tests: { readonly forName: string | null; readonly files: string[]; readonly error: unknown };
}

/** Develop this render's content in, seeded (the send number). */
export interface RenderReveal {
  readonly seed: number;
}

const RESPONSE_TABS = ["BODY", "HEADERS", "TESTS"] as const;

/** Frame rows plus the status and tab rows: what the content cannot use. */
const CHROME_ROWS = 4;
/** Frame columns plus the pane's horizontal padding. */
const CHROME_COLS = 4;
/** Skeleton rows at most: a hint of a body, not a wall. */
const MAX_SKELETON_ROWS = 8;

/** The pane's content size from its last layout (a first render sees 0). */
function contentSize(pane: BoxRenderable): { width: number; rows: number } {
  return { width: Math.max(1, pane.width - CHROME_COLS), rows: Math.max(1, pane.height - CHROME_ROWS) };
}

/**
 * Build the pane's children for `state`. Returns the busy header when the
 * view is a send in flight (its label updates in place). With `reveal`,
 * a result's or error's content develops in: the body block swaps its
 * plain lines in when it settles, and developed texts settle on exactly
 * the text they replaced.
 */
export function renderResponsePane(
  renderer: CliRenderer,
  pane: BoxRenderable,
  state: ResponseRenderState,
  reveal: RenderReveal | null = null,
): BusyHeader | null {
  const busy = state.view.kind === "sending" ? busyHeader(renderer, state.view.ticket) : null;
  const header = busy === null ? statusChunks(state) : busy.node;
  const status = statusLine(renderer, pane, header);
  if (status !== null) pane.add(status);
  pane.add(tabsRow(renderer, RESPONSE_TABS, tabIndexOf(state.tab), THEME.color.accent));

  const content = contentNodes(renderer, pane, state, reveal);
  for (const node of content) pane.add(node);
  if (state.note !== null) pane.add(diagnosticText(renderer, state.note, THEME.color.muted));
  if (reveal !== null) {
    // The body block develops itself; the texts around it develop here.
    const texts = content.filter(node => !(node instanceof ScrollBoxRenderable));
    developTexts(renderer, texts, { seed: reveal.seed, width: contentSize(pane).width });
  }
  return busy;
}

/** What goes under the tabs for the current view. */
function contentNodes(
  renderer: CliRenderer,
  pane: BoxRenderable,
  state: ResponseRenderState,
  reveal: RenderReveal | null,
): Renderable[] {
  const { view } = state;
  if (view.kind === "result") return resultNodes(renderer, pane, state, reveal);
  if (view.kind === "error") return [diagnosticText(renderer, errorLine(view.error), THEME.color.love)];
  if (view.kind === "sending") {
    // Sized like the result's note and code block (zero basis, clipped), so
    // the pane keeps its height from busy to settled instead of jumping.
    const room = new BoxRenderable(renderer, {
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 0,
      minHeight: 2,
      width: "100%",
      overflow: "hidden",
    });
    const rows = Math.min(MAX_SKELETON_ROWS, Math.max(1, contentSize(pane).rows - 1));
    room.add(skeletonLines(renderer, { lines: rows, width: "100%" }));
    return [room];
  }
  // TESTS is meaningful before any send: the workspace's generated tests.
  if (state.tab === "tests") return testsView(renderer, state);
  // The one shared empty-state style, scoped to the area under the status
  // line and tabs.
  return [
    emptyStateBox(renderer, [
      { text: "no response yet", tone: "message" },
      { text: "select a request in collections and press ⏎", tone: "hint" },
    ]),
  ];
}

function resultNodes(
  renderer: CliRenderer,
  pane: BoxRenderable,
  state: ResponseRenderState,
  reveal: RenderReveal | null,
): Renderable[] {
  if (state.view.kind !== "result") return [];
  const { result, extraSecrets, forName } = state.view;
  // The full scrub list: resolved env values from the pipeline plus any
  // literal credential values the sent draft carried.
  const secrets = [...result.secrets, ...extraSecrets];
  const nodes: Renderable[] = [];
  // The redirect warning mirrors the CLI's stderr diagnostic; the URL is
  // scrubbed like every other rendered value.
  if (result.outcome.redirectedTo !== null) {
    nodes.push(
      new TextRenderable(renderer, {
        content: `warning: followed redirect; response describes ${scrubSecrets(result.outcome.redirectedTo, secrets)}`,
        fg: THEME.color.gold,
        wrapMode: "word",
        width: "100%",
      }),
    );
  }
  // Non-2xx sends carry the pipeline's named rejection; it surfaces on the
  // diagnostic region exactly as the CLI prints it on stderr.
  if (result.outcome.kind === "rejected" && result.outcome.error !== undefined) {
    nodes.push(diagnosticText(renderer, errorLine(result.outcome.error), THEME.color.love));
  }
  // A send can settle after the user opened a different request; label the
  // staleness instead of silently conflating two requests' responses.
  if (forName !== "" && state.requestName !== null && forName !== state.requestName) {
    nodes.push(
      diagnosticText(renderer, `this response is from ${forName} — ${state.requestName} is loaded now`, THEME.color.muted),
    );
  }
  // The lines under the tab view are built first: the body needs their count.
  return [...tabView(renderer, { pane, state, result, secrets, reveal, below: nodes.length }), ...nodes];
}

function tabIndexOf(tab: "body" | "headers" | "tests"): number {
  if (tab === "body") return 0;
  if (tab === "headers") return 1;
  return 2;
}

/**
 * The mockup's header row — `RESPONSE   201 CREATED │ 184 ms │ 642 B`, the
 * label on the left and the status on the right of ONE row. When the pane's
 * border already carries the RESPONSE title, the status goes up onto that
 * same border row, right-aligned (positioned into it: the pane does not
 * clip overflow), and costs the body no row. A pane without a bordered
 * title gets label and status as an ordinary first row instead.
 */
function statusLine(
  renderer: CliRenderer,
  pane: BoxRenderable,
  header: TextChunk[] | BoxRenderable,
): Renderable | null {
  let node: Renderable | null = null;
  if (header instanceof BoxRenderable) node = header;
  else if (header.length > 0) node = new TextRenderable(renderer, { content: new StyledText(header) });
  if (hasBorderTitle(pane)) {
    if (node === null) return null;
    const slot = new BoxRenderable(renderer, {
      // An opaque background with a column of padding each side: the slot
      // must blank the border line under it (the pane's own fill, which its
      // frame row sits on).
      backgroundColor: THEME.color.panel,
      paddingX: 1,
      position: "absolute",
      top: -1,
      right: 1,
    });
    slot.add(node);
    return slot;
  }
  const row = new BoxRenderable(renderer, {
    flexDirection: "row",
    justifyContent: "space-between",
    width: "100%",
  });
  row.add(new TextRenderable(renderer, { content: new StyledText([bold(fg(THEME.color.text)("RESPONSE"))]) }));
  if (node !== null) row.add(node);
  return row;
}

/** True when the pane draws a titled top border (the title renders on it). */
function hasBorderTitle(pane: BoxRenderable): boolean {
  const { border } = pane;
  const top = border === true || (Array.isArray(border) && border.includes("top"));
  return top && (pane.title ?? "") !== "";
}

/** A settled view's status: result chips or the error marker; empty when idle. */
function statusChunks(state: ResponseRenderState): TextChunk[] {
  const { view } = state;
  if (view.kind === "result") {
    const { outcome } = view.result;
    return resultChunks(outcome.status, view.latencyMs, outcome.response.size, view.stamp);
  }
  if (view.kind === "error") return errorChunks(view.stamp);
  return [];
}

interface TabInput {
  readonly pane: BoxRenderable;
  readonly state: ResponseRenderState;
  readonly result: SendResult;
  readonly secrets: string[];
  readonly reveal: RenderReveal | null;
  /** Rows the diagnostics under the tab view take (one each, a guess). */
  readonly below: number;
}

/** The active tab's view, built fresh for each render. */
function tabView(renderer: CliRenderer, input: TabInput): Renderable[] {
  if (input.state.tab === "body") return bodyView(renderer, input);
  if (input.state.tab === "headers") return headersView(renderer, input.result, input.secrets);
  return testsView(renderer, input.state);
}

/**
 * The bounded body digest: window note plus the line-numbered excerpt —
 * JSON pretty-printed and colored by token kind; anything else as its own
 * lines. A truncated excerpt that no longer parses as a whole is laid out up
 * to the cut (the note says where the window ends); one that is not JSON
 * at all shows raw.
 */
function bodyView(renderer: CliRenderer, { pane, state, result, secrets, reveal, below }: TabInput): Renderable[] {
  const { response } = result.outcome;
  // Scrub before splitting, formatting, or numbering: a secret spanning a
  // line break (or two JSON tokens) is still one contiguous string here, so
  // the marker replaces all of it. The formatter never decodes escapes, so
  // nothing it prints can reassemble a scrubbed value.
  const excerpt = scrubSecrets(response.excerpt, secrets);
  let note: string;
  if (response.excerpt === "") {
    note = `${response.shape} · body is empty`;
  } else if (response.truncated) {
    note = `${response.shape} · showing first ${response.excerptBytes} of ${response.size} bytes — + widens (window ${formatBytes(state.bodyWindow)})`;
  } else {
    note = `${response.shape} · ${response.size} bytes (complete)`;
  }
  const noteText = new TextRenderable(renderer, { content: note, fg: THEME.color.muted, width: "100%" });
  if (response.excerpt === "") return [noteText];
  const layout = highlighted(excerpt, response.truncated);
  if (reveal === null) return [noteText, codeBlock(renderer, layout)];
  // The note row sits above the block and the diagnostics below it; the
  // count only decides whether a scroll bar takes a column.
  const { width, rows } = contentSize(pane);
  const block = developingCodeBlock(renderer, layout, { width, rows: rows - 1 - below, seed: reveal.seed });
  return [noteText, block];
}

/** The last layout, reused while the excerpt is unchanged (tab flips re-render). */
let lastLayout: { text: string; truncated: boolean; result: HighlightedJson } | null = null;

function highlighted(text: string, truncated: boolean): HighlightedJson {
  if (lastLayout?.text !== text || lastLayout.truncated !== truncated) {
    lastLayout = { text, truncated, result: highlightJson(text, { truncated }) };
  }
  return lastLayout.result;
}

/** Response headers as captured by the pipeline: credential values already [redacted]. */
function headersView(renderer: CliRenderer, result: SendResult, secrets: string[]): TextRenderable[] {
  const { response } = result.outcome;
  const lines = response.headers.map(([name, value]) => `  ${name}: ${value}`);
  if (response.headersOmitted > 0) lines.push(`  (+${response.headersOmitted} more response headers)`);
  if (lines.length === 0) return [diagnosticText(renderer, "(no response headers)", THEME.color.text)];
  return [
    new TextRenderable(renderer, {
      content: scrubSecrets(lines.join("\n"), secrets),
      fg: THEME.color.text,
      wrapMode: "word",
      width: "100%",
    }),
  ];
}

function testsView(renderer: CliRenderer, state: ResponseRenderState): Renderable[] {
  if (state.requestName === null) {
    return [
      emptyStateBox(renderer, [
        { text: "no request selected", tone: "message" },
        { text: "open one in collections (⏎)", tone: "hint" },
      ]),
    ];
  }
  if (state.tests.forName !== state.requestName) {
    // The listing in hand belongs to a different (or previous) request —
    // a fresh read is in flight; say so instead of showing stale files.
    return [diagnosticText(renderer, "reading tests…", THEME.color.muted)];
  }
  if (state.tests.error !== undefined) {
    return [diagnosticText(renderer, errorLine(state.tests.error), THEME.color.love)];
  }
  if (state.tests.files.length === 0) {
    // The honest empty state the ticket asks for, worded like the CLI's hint,
    // in the one shared empty-state style.
    return [
      emptyStateBox(renderer, [
        { text: `no generated tests for ${state.requestName}`, tone: "message" },
        { text: "run postui gen", tone: "command" },
      ]),
    ];
  }
  return state.tests.files.map(file => diagnosticText(renderer, `  tests/${file}`, THEME.color.text));
}

function diagnosticText(renderer: CliRenderer, text: string, color: string): TextRenderable {
  return new TextRenderable(renderer, {
    // One diagnostic line, never a multi-line dump: newlines flatten.
    content: text.replaceAll("\n", " "),
    fg: color,
    wrapMode: "word",
    width: "100%",
  });
}
