// @provenance rule: rule_agent_body_cap
import { redactHeaders } from "./redact.ts";

/** Default body-excerpt window in bytes. */
export const DEFAULT_BODY_WINDOW = 256;

/** Header lines shown per block before the rest is summarized as a count. */
export const MAX_DISPLAY_HEADERS = 32;

/** Characters shown per header value before an ellipsis. */
export const MAX_HEADER_VALUE_CHARS = 256;

/** A captured response with every field the bounded views render. */
export interface CapturedResponse {
  status: number;
  /** Header entries, credential values replaced, count-capped. */
  headers: Array<[string, string]>;
  /** How many response headers were capped out of the view. */
  headersOmitted: number;
  /** Response body size in bytes. */
  size: number;
  /** Bounded structural summary of the body (no values). */
  shape: string;
  /** Decoded first `window` bytes of the body (scrubbed later, at render). */
  excerpt: string;
  /** How many body bytes the excerpt covers (0 when there is nothing to show). */
  excerptBytes: number;
  /** True when the body was larger than the window that was kept. */
  truncated: boolean;
}

/**
 * Capture a fetch Response into the bounded view: redact credential headers,
 * cap the header list, measure the body, describe its shape, and keep only
 * the first `window` bytes as the excerpt.
 */
export function captureResponse(
  response: { status: number; headers: Headers },
  body: ArrayBuffer,
  window: number,
): CapturedResponse {
  const entries: Array<[string, string]> = [...response.headers.entries()];
  const headers = redactHeaders(entries.slice(0, MAX_DISPLAY_HEADERS)).map(([name, value]) => [
    name,
    clip(value, MAX_HEADER_VALUE_CHARS),
  ] as [string, string]);
  return {
    status: response.status,
    headers,
    headersOmitted: Math.max(0, entries.length - MAX_DISPLAY_HEADERS),
    size: body.byteLength,
    shape: describeBodyShape(body, response.headers.get("content-type")),
    ...bodyExcerpt(body, window),
  };
}

/** Bounded structural summary of a body: never contains body values. */
export function describeBodyShape(body: ArrayBuffer, contentType: string | null): string {
  if (body.byteLength === 0) return "empty";
  const text = new TextDecoder("utf-8", { fatal: false }).decode(body);
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return `json array of ${parsed.length} items`;
    if (typeof parsed === "object" && parsed !== null) {
      return `json object with ${Object.keys(parsed).length} keys`;
    }
    return "json scalar";
  } catch {
    const base = contentType?.split(";")[0]?.trim();
    return base === undefined || base === "" ? "opaque" : base;
  }
}

/** Keep the first `window` bytes of the body, decoded lossily. */
export function bodyExcerpt(
  body: ArrayBuffer,
  window: number,
): { excerpt: string; excerptBytes: number; truncated: boolean } {
  const size = body.byteLength;
  const keep = Math.max(0, Math.min(window, size));
  return {
    excerpt: keep === 0 ? "" : new TextDecoder("utf-8", { fatal: false }).decode(body.slice(0, keep)),
    excerptBytes: keep,
    truncated: size > window,
  };
}

/** Clip a rendered string to max characters, marking the cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
