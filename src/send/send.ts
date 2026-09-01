// @provenance rule: rule_agent_one_shot

// @provenance rule: rule_single_source_shared_input
//
// One command, no user input: sendRequest reads nothing from stdin and
// prompts for nothing. The requests folder is the only input; credential
// VALUES are never read from anywhere but the environment (rule_env_only_
// credentials is enforced by the CLI refusing every unknown option). All
// referenced names resolve before any network I/O; one unset name fails the
// whole send. Exit mapping (see src/cli.ts runSend): 0 sent, 1 rejected or
// transport failure after the send started, 2 misfire.
import { Schema } from "effect";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  BadSendDefinitionError,
  NetworkPathError,
  SendRejectedError,
  TransportFailureError,
} from "./errors.ts";
import { resolveEnvValues, collectEnvNames } from "./env.ts";
import {
  DEFAULT_BODY_WINDOW,
  MAX_DISPLAY_HEADERS,
  MAX_HEADER_VALUE_CHARS,
  captureResponse,
  clip,
} from "./response.ts";
import type { CapturedResponse } from "./response.ts";
import { loadRequestByName } from "../gen/load.ts";
import type { LoadedRequest } from "../gen/load.ts";
import { substituteEnvRefs } from "../save/credentials.ts";
import { redactHeaders, scrubSecrets } from "./redact.ts";
import { SendResultJson } from "../schema.ts";

export interface SendOptions {
  /** Saved request module name (without extension). */
  name: string;
  /** Requests folder. Defaults to "requests" in the working directory. */
  requestsDir?: string;
  /**
   * Explicit ask-for-more body window in bytes. Default: DEFAULT_BODY_WINDOW.
   * This is the only way to widen the body view; there is no unbounded mode.
   */
  bodyWindow?: number;
}

/** What the send looked like on the wire, with credential values redacted. */
interface SendRequestView {
  method: string;
  url: string;
  headers: Array<[string, string]>;
  headersOmitted: number;
}

export type SendOutcome = {
  kind: "sent" | "rejected";
  status: number;
  request: SendRequestView;
  response: CapturedResponse;
  /** Final URL after redirects, when fetch followed a redirect chain. */
  redirectedTo: string | null;
  /** Present only when kind is "rejected". */
  error?: SendRejectedError;
};

export interface SendResult {
  outcome: SendOutcome;
  /**
   * Environment values resolved for this send, prepared for scrubbing.
   * Every output path scrubs with this list; it never contains credential
   * header NAMES, only the values that must not surface.
   */
  secrets: string[];
}

/**
 * Send one saved request against the real API, in one shot. Every failure
 * that can happen before the network — module load, URL shape, missing
 * environment names, unreadable form files — happens before the first byte
 * leaves the process. Resolved environment values are returned for output
 * scrubbing and never placed on the outcome itself.
 */
export async function sendRequest(opts: SendOptions): Promise<SendResult> {
  const dir = opts.requestsDir ?? "requests";
  const window = opts.bodyWindow ?? DEFAULT_BODY_WINDOW;
  const loaded = await loadRequestByName(dir, opts.name);

  // Environment resolution happens here, at send start — after the request
  // definition is in hand, before any network I/O, all names or none.
  const names = collectEnvNames(loaded.request);
  const values = resolveEnvValues(names);
  const resolve = (name: string): string | undefined => values.get(name);
  const secrets = [...values.values()];

  const urlText = substituteEnvRefs(loaded.request.url, resolve);
  const requestHeaders: Array<[string, string]> = Object.entries(loaded.request.headers).map(
    ([name, value]) => [name, substituteEnvRefs(value, resolve)],
  );

  const url = parseSendUrl(urlText, secrets);
  const method = validMethod(loaded.request.method);
  if ((method === "GET" || method === "HEAD") && loaded.request.body !== null) {
    // Rejected here, before any body work, so it cannot masquerade as a
    // transport failure: no bytes were ever at risk.
    throw new BadSendDefinitionError({
      message: `saved request defines a body on ${method} — remove it or change the method`,
    });
  }
  const { body, isForm } = await buildBody(loaded, resolve, secrets);
  // A multipart boundary is chosen when the body is encoded, so a saved
  // content-type would carry a stale boundary; fetch sets the right one.
  const headersOut = isForm
    ? Object.fromEntries(requestHeaders.filter(([name]) => name.toLowerCase() !== "content-type"))
    : Object.fromEntries(requestHeaders);

  let response: Response;
  let buffer: ArrayBuffer;
  try {
    // Redirects are followed; the digest describes the final response of
    // the chain. The full body is buffered in memory (output stays bounded
    // regardless; a multi-gigabyte response would need a streaming design
    // postui deliberately does not have yet). No timeout is imposed: a
    // hung server hangs the send, and a default timeout value is an
    // unratified product decision.
    response = await fetch(url, { method, headers: headersOut, body });
    buffer = await response.arrayBuffer();
  } catch (cause) {
    throw classifyTransportError(cause, secrets);
  }

  const captured = captureResponse(response, buffer, window);
  const view = requestView(method, urlText, requestHeaders);
  const redirectedTo = response.url !== "" && response.url !== url.href ? response.url : null;

  if (response.status >= 200 && response.status < 300) {
    return { outcome: { kind: "sent", status: response.status, request: view, response: captured, redirectedTo }, secrets };
  }
  return {
    outcome: {
      kind: "rejected",
      status: response.status,
      request: view,
      response: captured,
      redirectedTo,
      error: new SendRejectedError({
        status: response.status,
        message: `API rejected the send with status ${response.status}`,
      }),
    },
    secrets,
  };
}

/** The bounded, structurally redacted request view shown in both output modes. */
function requestView(method: string, urlText: string, headers: Array<[string, string]>): SendRequestView {
  const shown = redactHeaders(headers.slice(0, MAX_DISPLAY_HEADERS)).map(([name, value]) => [
    name,
    clip(value, MAX_HEADER_VALUE_CHARS),
  ] as [string, string]);
  return {
    method,
    url: clip(urlText, MAX_HEADER_VALUE_CHARS),
    headers: shown,
    headersOmitted: Math.max(0, headers.length - MAX_DISPLAY_HEADERS),
  };
}

function parseSendUrl(urlText: string, secrets: string[]): URL {
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    // The url text already carries substituted env values, so the message
    // must be scrubbed like every other output.
    throw new BadSendDefinitionError({
      message: `saved request url does not parse: ${scrubLine(clip(urlText, MAX_HEADER_VALUE_CHARS), secrets)}`,
    });
  }
  return url;
}

/** A method must be an HTTP token; anything else is a bad definition. */
function validMethod(method: string): string {
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(method)) {
    throw new BadSendDefinitionError({ message: `saved request method is not an HTTP token: "${method}"` });
  }
  return method;
}

/** Substitute refs, then read form file payloads — all before any network I/O. */
async function buildBody(
  loaded: LoadedRequest,
  resolve: (name: string) => string | undefined,
  secrets: string[],
): Promise<{ body: FormData | string | undefined; isForm: boolean }> {
  const saved = loaded.request.body;
  if (saved === null) return { body: undefined, isForm: false };
  if (typeof saved === "string") {
    return { body: substituteEnvRefs(saved, resolve), isForm: false };
  }
  const form = new FormData();
  const parts = await Promise.all(
    saved.map(async entry => {
      if (entry.file !== undefined) {
        const path = substituteEnvRefs(entry.file, resolve);
        try {
          return { entry, path, content: await readFile(path) };
        } catch {
          // The path may carry substituted env values; scrub like every output.
          throw new BadSendDefinitionError({
            message:
              `form entry "${entry.name}" points at an unreadable file: ` +
              `${scrubLine(path, secrets)}`,
          });
        }
      }
      return { entry, path: "", content: null };
    }),
  );
  for (const { entry, path, content } of parts) {
    if (content !== null) {
      form.append(entry.name, new Blob([new Uint8Array(content)]), basename(path));
    } else {
      form.append(entry.name, substituteEnvRefs(entry.value ?? "", resolve));
    }
  }
  return { body: form, isForm: true };
}

/**
 * Map a fetch failure onto the two-tier contract. A failure that carries a
 * postui could not make the send at all (misfire, exit 2). Everything else —
 * including unknown error shapes, which by definition happened after the
 * request was in flight — is a transport failure (exit 1); retrying may
 * help. Request-shape problems never reach here: they are rejected before
 * fetch. Messages are scrubbed because fetch errors echo the request URL,
 * which can carry credential values.
 */
export function classifyTransportError(cause: unknown, secrets: string[]): NetworkPathError | TransportFailureError {
  const code = causeCode(cause);
  const detail = `${code === null ? "" : `${code} `}${scrubLine(messageOf(cause), secrets)}`;
  if (code !== null && (PRE_CONNECT_CODES.has(code) || code.includes("CERT") || code.startsWith("ERR_TLS") || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE")) {
    return new NetworkPathError({ message: `could not establish a network path: ${detail}` });
  }
  return new TransportFailureError({ message: `send started but the transport failed: ${detail}` });
}

const PRE_CONNECT_CODES = new Set([
  // errno-style
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EACCES",
  "ETIMEDOUT",
  // Bun's syscall-error names for the same conditions
  "ConnectionRefused",
  "DnsNotFound",
  "HostUnreachable",
  "NetworkUnreachable",
  "AccessDenied",
  "TimedOut",
]);

/** Walk a few wrapper levels looking for an errno-style code string. */
function causeCode(cause: unknown): string | null {
  let current: unknown = cause;
  for (let depth = 0; depth < 4 && current !== null && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** One line, secrets scrubbed — safe to embed in any error message. */
function scrubLine(text: string, secrets: string[]): string {
  return scrubSecrets(text.replaceAll("\n", " "), secrets);
}

// ---------------------------------------------------------------------------
// Bounded output views. Both render from the already-redacted outcome and
// finish with a scrub over every resolved environment value, so nothing an
// API echoes back can carry a secret out.
// ---------------------------------------------------------------------------

/** Human digest: status, redacted headers, size, body shape, short excerpt. */
export function renderDigest(outcome: SendOutcome, secrets: string[]): string {
  const lines: string[] = [
    `${outcome.request.method} ${outcome.request.url} -> ${outcome.status}`,
    "request headers:",
  ];
  for (const [name, value] of outcome.request.headers) {
    lines.push(`  ${name}: ${value}`);
  }
  if (outcome.request.headersOmitted > 0) {
    lines.push(`  (+${outcome.request.headersOmitted} more request headers)`);
  }
  lines.push("response headers:");
  for (const [name, value] of outcome.response.headers) {
    lines.push(`  ${name}: ${value}`);
  }
  if (outcome.response.headersOmitted > 0) {
    lines.push(`  (+${outcome.response.headersOmitted} more response headers)`);
  }
  lines.push(`body: ${outcome.response.size} bytes, ${outcome.response.shape}`);
  if (outcome.response.excerpt !== "") {
    lines.push(
      outcome.response.truncated
        ? `body excerpt (first ${outcome.response.excerptBytes} of ${outcome.response.size} bytes):`
        : `body excerpt (${outcome.response.size} bytes):`,
    );
    lines.push(outcome.response.excerpt);
  }
  // One scrub over the whole rendered digest: any env value the API echoed
  // back — in headers, the excerpt, anywhere — is replaced here.
  return scrubSecrets(lines.join("\n"), secrets);
}

/**
 * JSON digest: the same bounded, redacted view, encoded through the Effect
 * Schema contract before serialization, scrubbed after. The result is the
 * sole JSON value printed to stdout in --json mode.
 */
export function renderJson(outcome: SendOutcome, secrets: string[]): string {
  const payload = Schema.encodeSync(SendResultJson)({
    request: {
      method: outcome.request.method,
      url: outcome.request.url,
      headers: outcome.request.headers,
      headersOmitted: outcome.request.headersOmitted,
    },
    response: {
      status: outcome.response.status,
      headers: outcome.response.headers,
      headersOmitted: outcome.response.headersOmitted,
      size: outcome.response.size,
      shape: outcome.response.shape,
      excerpt: outcome.response.excerpt,
      excerptBytes: outcome.response.excerptBytes,
      truncated: outcome.response.truncated,
    },
  });
  return scrubSecrets(JSON.stringify(payload, null, 2), secrets);
}
