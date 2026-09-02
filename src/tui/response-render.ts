import { BoxRenderable, StyledText, TextRenderable, bold, fg } from "@opentui/core";
import type { CliRenderer, TextChunk } from "@opentui/core";
import { scrubSecrets } from "../send/redact.ts";
import type { SendResult } from "../send/send.ts";
import { errorLine, numberedLines, tabsRow } from "./render.ts";
import { THEME } from "./theme.ts";

/**
 * Response pane rendering: the mockup's status line (status code colored —
 * gold for success, the accent red for errors — plus latency and size),
 * BODY/HEADERS/TESTS tabs, and the diagnostic region.
 *
 * REDACTION: every text derived from a send is scrubbed against that send's
 * resolved env values before it is placed in the pane — the same final pass
 * renderDigest() does on the CLI, applied on every path, with no option to
 * skip it (rule_redaction_no_off_switch). Header credential values are
 * already replaced with the fixed marker (REDACTED) by the pipeline's
 * capture.
 */

export interface ResponseRenderState {
  readonly tab: "body" | "headers" | "tests";
  readonly bodyWindow: number;
  readonly view:
    | { readonly kind: "idle" }
    | { readonly kind: "sending" }
    | {
        readonly kind: "result";
        readonly result: SendResult;
        readonly latencyMs: number;
        readonly extraSecrets: string[];
        readonly forName: string;
      }
    | { readonly kind: "error"; readonly error: unknown };
  readonly note: string | null;
  readonly requestName: string | null;
  readonly tests: { readonly forName: string | null; readonly files: string[]; readonly error: unknown };
}

const RESPONSE_TABS = ["BODY", "HEADERS", "TESTS"] as const;

export function renderResponsePane(
  renderer: CliRenderer,
  pane: BoxRenderable,
  state: ResponseRenderState,
): void {
  pane.add(statusRow(renderer, state));
  pane.add(tabsRow(renderer, RESPONSE_TABS, tabIndexOf(state.tab), THEME.color.gold));

  if (state.view.kind === "result") {
    const { result, extraSecrets } = state.view;
    // The full scrub list: resolved env values from the pipeline plus any
    // literal credential values the sent draft carried.
    const secrets = [...result.secrets, ...extraSecrets];
    for (const row of tabView(renderer, state, result, secrets)) pane.add(row);
    // The redirect warning mirrors the CLI's stderr diagnostic; the URL is
    // scrubbed like every other rendered value.
    if (result.outcome.redirectedTo !== null) {
      pane.add(
        new TextRenderable(renderer, {
          content: `warning: followed redirect; response describes ${scrubSecrets(result.outcome.redirectedTo, secrets)}`,
          fg: THEME.color.dim,
          wrapMode: "word",
          width: "100%",
        }),
      );
    }
    // Non-2xx sends carry the pipeline's named rejection; it surfaces on the
    // diagnostic region exactly as the CLI prints it on stderr.
    if (result.outcome.kind === "rejected" && result.outcome.error !== undefined) {
      pane.add(diagnosticText(renderer, errorLine(result.outcome.error), THEME.color.accent));
    }
    // A send can settle after the user opened a different request; label the
    // staleness instead of silently conflating two requests' responses.
    if (
      state.view.forName !== "" &&
      state.requestName !== null &&
      state.view.forName !== state.requestName
    ) {
      pane.add(
        diagnosticText(
          renderer,
          `this response is from ${state.view.forName} — ${state.requestName} is loaded now`,
          THEME.color.dim,
        ),
      );
    }
  } else if (state.view.kind === "error") {
    pane.add(diagnosticText(renderer, errorLine(state.view.error), THEME.color.accent));
  } else if (state.view.kind === "sending") {
    pane.add(diagnosticText(renderer, "sending…", THEME.color.dim));
  } else if (state.tab === "tests") {
    // TESTS is meaningful before any send: the workspace's generated tests.
    for (const row of testsView(renderer, state)) pane.add(row);
  } else {
    pane.add(
      diagnosticText(renderer, "no response yet — select a request in collections and press ⏎", THEME.color.text),
    );
  }

  if (state.note !== null) {
    pane.add(diagnosticText(renderer, state.note, THEME.color.dim));
  }
}

function tabIndexOf(tab: "body" | "headers" | "tests"): number {
  if (tab === "body") return 0;
  if (tab === "headers") return 1;
  return 2;
}

/** Status/latency/size on the right, per the mockup; error marker when one sits. */
function statusRow(renderer: CliRenderer, state: ResponseRenderState): BoxRenderable {
  const row = new BoxRenderable(renderer, {
    flexDirection: "row",
    justifyContent: "flex-end",
    width: "100%",
  });
  if (state.view.kind === "result") {
    const { outcome } = state.view.result;
    row.add(
      new TextRenderable(renderer, {
        content: new StyledText([
          statusChunk(outcome.status),
          dim("  │  "),
          dim(`${Math.max(1, Math.round(state.view.latencyMs))} ms`),
          dim("  │  "),
          dim(formatBytes(outcome.response.size)),
        ]),
      }),
    );
  } else if (state.view.kind === "error") {
    row.add(
      new TextRenderable(renderer, {
        content: new StyledText([bold(fg(THEME.color.accent)("✗ error"))]),
      }),
    );
  } else if (state.view.kind === "sending") {
    row.add(new TextRenderable(renderer, { content: new StyledText([dim("sending…")]) }));
  }
  return row;
}

function statusChunk(status: number): TextChunk {
  const label = `${status} ${reasonPhrase(status)}`.trimEnd();
  if (status >= 200 && status < 300) {
    // Gold is the theme's response-highlight color; success earns it.
    return bold(fg(THEME.color.gold)(label));
  }
  if (status >= 400) {
    return bold(fg(THEME.color.accent)(label));
  }
  return bold(fg(THEME.color.text)(label));
}

function dim(text: string): TextChunk {
  return fg(THEME.color.dim)(text);
}

/** Uppercased reason phrase for the codes a human actually meets; else bare code. */
function reasonPhrase(status: number): string {
  const phrases: Record<number, string> = {
    200: "OK",
    201: "CREATED",
    202: "ACCEPTED",
    204: "NO CONTENT",
    301: "MOVED PERMANENTLY",
    302: "FOUND",
    304: "NOT MODIFIED",
    400: "BAD REQUEST",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT FOUND",
    405: "METHOD NOT ALLOWED",
    409: "CONFLICT",
    410: "GONE",
    415: "UNSUPPORTED MEDIA TYPE",
    422: "UNPROCESSABLE ENTITY",
    429: "TOO MANY REQUESTS",
    500: "INTERNAL SERVER ERROR",
    501: "NOT IMPLEMENTED",
    502: "BAD GATEWAY",
    503: "SERVICE UNAVAILABLE",
    504: "GATEWAY TIMEOUT",
  };
  return phrases[status] ?? "";
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** The active tab's view, built fresh for each render. */
function tabView(
  renderer: CliRenderer,
  state: ResponseRenderState,
  result: SendResult,
  secrets: string[],
): TextRenderable[] {
  if (state.tab === "body") return bodyView(renderer, state, result, secrets);
  if (state.tab === "headers") return headersView(renderer, result, secrets);
  return testsView(renderer, state);
}

/** The bounded body digest: window note plus the line-numbered excerpt. */
function bodyView(
  renderer: CliRenderer,
  state: ResponseRenderState,
  result: SendResult,
  secrets: string[],
): TextRenderable[] {
  const { response } = result.outcome;
  // Scrub before splitting or numbering: a secret spanning a line break is
  // still one contiguous string here, so the marker replaces all of it.
  const excerpt = scrubSecrets(response.excerpt, secrets);
  let note: string;
  if (response.excerpt === "") {
    note = `${response.shape} · body is empty`;
  } else if (response.truncated) {
    note = `${response.shape} · showing first ${response.excerptBytes} of ${response.size} bytes — + widens (window ${formatBytes(state.bodyWindow)})`;
  } else {
    note = `${response.shape} · ${response.size} bytes (complete)`;
  }
  return [
    new TextRenderable(renderer, { content: note, fg: THEME.color.dim, width: "100%" }),
    ...(response.excerpt === "" ? [] : numberedLines(renderer, excerpt, THEME.color.gold)),
  ];
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

function testsView(renderer: CliRenderer, state: ResponseRenderState): TextRenderable[] {
  if (state.requestName === null) {
    return [diagnosticText(renderer, "no request selected", THEME.color.text)];
  }
  if (state.tests.forName !== state.requestName) {
    // The listing in hand belongs to a different (or previous) request —
    // a fresh read is in flight; say so instead of showing stale files.
    return [diagnosticText(renderer, "reading tests…", THEME.color.dim)];
  }
  if (state.tests.error !== undefined) {
    return [diagnosticText(renderer, errorLine(state.tests.error), THEME.color.accent)];
  }
  if (state.tests.files.length === 0) {
    // The honest empty state the ticket asks for, worded like the CLI's hint.
    return [
      diagnosticText(renderer, `no generated tests for ${state.requestName}`, THEME.color.text),
      diagnosticText(renderer, "run postui gen", THEME.color.bright),
    ];
  }
  return state.tests.files.map(file =>
    diagnosticText(renderer, `  tests/${file}`, THEME.color.text),
  );
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
