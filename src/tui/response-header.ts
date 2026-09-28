import { BoxRenderable, StyledText, TextRenderable, bold, fg } from "@opentui/core";
import type { CliRenderer, TextChunk } from "@opentui/core";
import type { SendTarget } from "./composer-send.ts";
import { elapsedCounter } from "./fx/elapsed.ts";
import { halftoneSpinner } from "./fx/spinner.ts";
import { methodColor, THEME } from "./theme.ts";

/**
 * The response header — the status that sits on the RESPONSE border. While
 * a send runs it is a busy readout (halftone spinner, `GET /path`, a live
 * elapsed count); once the send settles it is the mockup's status line
 * (`201 CREATED │ 184 ms │ 642 B`) stamped with the send's number and
 * time of day, so two sends of the same request never paint the same
 * header.
 */

/** A send in flight, as the busy header shows it. */
export interface SendTicket {
  /** Per-session send counter, from 1. */
  readonly number: number;
  /** fx-clock time the send started (the elapsed count's zero). */
  readonly startedAt: number;
  /** What the send is aimed at; null until the send pipeline names it. */
  readonly target: SendTarget | null;
}

/** Which send a settled view came from: `#N · HH:MM:SS`. */
export interface SendStamp {
  readonly number: number;
  readonly time: string;
}

/** The busy header's request label, updated in place when the target arrives. */
export interface BusyHeader {
  readonly node: BoxRenderable;
  setTarget(target: SendTarget | null): void;
}

/** Longest path shown before it is cut with "…". */
const MAX_PATH = 40;

/** Wall-clock `HH:MM:SS`, local time. */
export function clockTime(date: Date): string {
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(part => String(part).padStart(2, "0")).join(":");
}

/**
 * The path a URL asks for, as a header shows it: `/users?page=2` for a full
 * URL; a template URL (`$BASE/users`) keeps its text after the env ref.
 */
export function targetPath(url: string): string {
  let path: string;
  try {
    const parsed = new URL(url);
    path = `${parsed.pathname}${parsed.search}`;
  } catch {
    const rest = url.replace(/^\$\{?[A-Za-z_]\w*\}?/, "");
    path = rest === "" ? url : rest;
  }
  return path.length > MAX_PATH ? `${path.slice(0, MAX_PATH - 1)}…` : path;
}

/** `GET /path` as chunks: the method in its badge colour, the path in the body text. */
export function targetChunks(target: SendTarget | null): TextChunk[] {
  if (target === null) return [fg(THEME.color.muted)("sending")];
  const method = target.method.toUpperCase();
  return [bold(fg(methodColor(method))(method)), fg(THEME.color.text)(` ${targetPath(target.url)}`)];
}

/** The status colour class: sage 2xx, gold 3xx, love 4xx/5xx (red means failure only). */
export function statusColor(status: number): string {
  if (status >= 400) return THEME.color.love;
  if (status >= 300) return THEME.color.gold;
  if (status >= 200) return THEME.color.sage;
  return THEME.color.text;
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** `#N · HH:MM:SS`, muted: the mark that makes a repeat send look new. */
function stampChunks(stamp: SendStamp): TextChunk[] {
  return [fg(THEME.color.muted)(`#${stamp.number} · ${stamp.time}`)];
}

const RULE = (): TextChunk => fg(THEME.color.border)(" │ ");

/** Status chip, latency, size and (when stamped) the send mark. */
export function resultChunks(
  status: number,
  latencyMs: number,
  size: number,
  stamp: SendStamp | null,
): TextChunk[] {
  const label = `${status} ${reasonPhrase(status)}`.trimEnd();
  const chunks = [
    bold(fg(statusColor(status))(label)),
    RULE(),
    fg(THEME.color.text)(`${Math.max(1, Math.round(latencyMs))} ms`),
    RULE(),
    fg(THEME.color.text)(formatBytes(size)),
  ];
  if (stamp !== null) chunks.push(RULE(), ...stampChunks(stamp));
  return chunks;
}

/** The failed-send marker, stamped like a result. */
export function errorChunks(stamp: SendStamp | null): TextChunk[] {
  const chunks = [bold(fg(THEME.color.love)("✗ error"))];
  if (stamp !== null) chunks.push(RULE(), ...stampChunks(stamp));
  return chunks;
}

/**
 * The busy readout as one row: spinner, `GET /path`, elapsed count. The
 * spinner and the count tick on the fx clock by themselves; the pane never
 * rebuilds the row to animate it.
 */
export function busyHeader(renderer: CliRenderer, ticket: SendTicket): BusyHeader {
  const node = new BoxRenderable(renderer, { flexDirection: "row", gap: 1, flexShrink: 0 });
  node.add(halftoneSpinner(renderer, { width: 4 }));
  const label = new TextRenderable(renderer, { content: new StyledText(targetChunks(ticket.target)) });
  node.add(label);
  node.add(elapsedCounter(renderer, { since: ticket.startedAt }));
  return {
    node,
    setTarget: target => {
      label.content = new StyledText(targetChunks(target));
    },
  };
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
