import { Data } from "effect";
import type { FormDataEntry, ParseWarning, RequestSpec } from "../types.ts";
import { ShellSyntaxError, splitShell } from "./shell.ts";

export class CurlParseError extends Data.TaggedError("CurlParseError")<
  { message: string }
> {}

/**
 * Known flags we intentionally ignore but should surface as warnings so the
 * user knows their curl wasn't fully understood.
 */
const IGNORED_FLAGS: Record<string, string> = {
  "-L": "follows redirects",
  "--location": "follows redirects",
  "-k": "skips TLS verification",
  "--insecure": "skips TLS verification",
  "-v": "verbose logging",
  "--verbose": "verbose logging",
  "-s": "silent mode",
  "--silent": "silent mode",
  "-c": "writes cookies to a jar",
  "--cookie-jar": "writes cookies to a jar",
};

interface Parsed {
  spec: RequestSpec;
  warnings: ParseWarning[];
}

/** Mutable state threaded through the flag handlers while scanning argv. */
interface ScanState {
  words: string[];
  idx: number;
  method: string | null;
  url: URL | null;
  headers: Array<[string, string]>;
  formEntries: FormDataEntry[];
  dataChunks: Array<{ text: string; urlencode: boolean }>;
  warnings: ParseWarning[];
}

type FlagHandler = (state: ScanState, flag: string) => void;

/** Consume one flag value starting at idx+1, advancing idx past both. */
function takeValue(state: ScanState, flag: string): string {
  const v = state.words[state.idx + 1];
  if (v === undefined || v.startsWith("-")) {
    throw new CurlParseError({ message: `flag ${flag} requires a value` });
  }
  state.idx += 2;
  return v;
}

function parseHeader(raw: string): [string, string] {
  const sep = raw.indexOf(":");
  if (sep === -1) {
    throw new CurlParseError({ message: `invalid header: "${raw}"` });
  }
  return [raw.slice(0, sep).trim(), raw.slice(sep + 1).trim()];
}

function parseFormEntry(raw: string): FormDataEntry {
  const eq = raw.indexOf("=");
  if (eq === -1) {
    throw new CurlParseError({ message: `invalid form field: "${raw}"` });
  }
  const name = raw.slice(0, eq);
  const value = raw.slice(eq + 1);
  return value.startsWith("@")
    ? { kind: "file", name, path: value.slice(1) }
    : { kind: "field", name, value };
}

const requestFlag: FlagHandler = (s, flag) => {
  s.method = takeValue(s, flag).toUpperCase();
};
const headerFlag: FlagHandler = (s, flag) => {
  s.headers.push(parseHeader(takeValue(s, flag)));
};
const dataFlag: FlagHandler = (s, flag) => {
  s.dataChunks.push({ text: takeValue(s, flag), urlencode: false });
};
const dataUrlencodeFlag: FlagHandler = (s, flag) => {
  s.dataChunks.push({ text: takeValue(s, flag), urlencode: true });
};
const formFlag: FlagHandler = (s, flag) => {
  s.formEntries.push(parseFormEntry(takeValue(s, flag)));
};
const userFlag: FlagHandler = (s, flag) => {
  s.headers.push(["Authorization", `Basic ${btoa(takeValue(s, flag))}`]);
};
const urlFlag: FlagHandler = (s, flag) => {
  s.url = parseUrl(takeValue(s, flag));
};

const FLAG_HANDLERS: Record<string, FlagHandler> = {
  "-X": requestFlag,
  "--request": requestFlag,
  "-H": headerFlag,
  "--header": headerFlag,
  "-d": dataFlag,
  "--data": dataFlag,
  "--data-raw": dataFlag,
  "--data-binary": dataFlag,
  "--data-urlencode": dataUrlencodeFlag,
  "-F": formFlag,
  "--form": formFlag,
  "-u": userFlag,
  "--user": userFlag,
  "--url": urlFlag,
};

function handlePositional(state: ScanState, word: string): void {
  if (state.url) {
    state.warnings.push({
      flag: word,
      message: "extra positional argument ignored",
    });
  } else {
    state.url = parseUrl(word);
  }
  state.idx++;
}

// @provenance rule: rule_flag_error_vs_warning
function scanWords(state: ScanState): void {
  while (state.idx < state.words.length) {
    const word = state.words[state.idx];
    if (word === undefined) break;

    const handler = FLAG_HANDLERS[word];
    const ignored = IGNORED_FLAGS[word];
    if (handler !== undefined) {
      handler(state, word);
    } else if (ignored !== undefined) {
      state.warnings.push({ flag: word, message: ignored });
      state.idx++;
    } else if (UNKNOWN_TAKES_VALUE.has(word)) {
      state.warnings.push({ flag: word, message: "unsupported flag ignored" });
      state.idx += 2;
    } else if (UNKNOWN_BARE.has(word)) {
      state.warnings.push({ flag: word, message: "unsupported flag ignored" });
      state.idx++;
    } else if (word.startsWith("-")) {
      throw new CurlParseError({ message: `unknown curl flag: ${word}` });
    } else {
      handlePositional(state, word);
    }
  }
}

/**
 * Parse a curl command into a RequestSpec.
 *
 * Accepts either:
 *   - a full shell string: `curl -X POST https://x.io -H 'A: b' -d '{"k":1}'`
 *   - pre-split argv without the leading `curl` (as from process.argv)
 */
export function parseCurl(input: string | string[]): Parsed {
  const words = typeof input === "string" ? toWords(input) : input.slice();

  const state: ScanState = {
    words,
    // Drop a leading "curl" if present.
    idx: words[0] === "curl" ? 1 : 0,
    method: null,
    url: null,
    headers: [],
    formEntries: [],
    dataChunks: [],
    warnings: [],
  };
  scanWords(state);

  if (!state.url) throw new CurlParseError({ message: "no URL found in curl command" });

  return {
    spec: buildSpec(state.method, state.url, state.headers, state.dataChunks, state.formEntries),
    warnings: state.warnings,
  };
}

// @provenance rule: rule_method_inference
function buildSpec(
  method: string | null,
  url: URL,
  headers: Array<[string, string]>,
  dataChunks: Array<{ text: string; urlencode: boolean }>,
  formEntries: FormDataEntry[],
): RequestSpec {
  const contentTypeHeader = headers.find(
    ([k]) => k.toLowerCase() === "content-type",
  );
  let body: RequestSpec["body"];

  if (formEntries.length > 0) {
    if (dataChunks.length > 0) {
      throw new CurlParseError({
        message: "cannot combine -d and -F in the same request",
      });
    }
    body = { kind: "form", entries: formEntries };
  } else if (dataChunks.length > 0) {
    const text = dataChunks
      .map(c => (c.urlencode ? encodeURIComponent(c.text) : c.text))
      .join("&");
    body = {
      kind: "raw",
      contentType: contentTypeHeader?.[1] ?? guessContentType(text),
      text,
    };
  } else {
    body = { kind: "none" };
  }

  // User-supplied headers win; fill in an inferred content-type otherwise.
  const finalHeaders = new Map(headers);
  const hasContentType = headers.some(([k]) => k.toLowerCase() === "content-type");
  if (body.kind === "raw" && !hasContentType && body.contentType) {
    finalHeaders.set("Content-Type", body.contentType);
  }

  return {
    // Body presence upgrades the default method.
    method: method ?? (body.kind === "none" ? "GET" : "POST"),
    url,
    headers: [...finalHeaders.entries()],
    body,
  };
}

function parseUrl(raw: string): URL {
  const withScheme =
    raw.startsWith("http://") || raw.startsWith("https://")
      ? raw
      : `http://${raw}`;
  try {
    return new URL(withScheme);
  } catch {
    throw new CurlParseError({ message: `invalid URL: ${raw}` });
  }
}

/** Distinguish JSON payloads from query-string-style or plain bodies. */
export function guessContentType(text: string): string | null {
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      JSON.parse(t);
      return "application/json";
    } catch {}
  }
  if (t.includes("=") && !t.startsWith("<")) {
    return "application/x-www-form-urlencoded";
  }
  return null;
}

/** Trim trailing backslash-newlines from pasted multiline commands. */
function stripTrailingBackslashes(s: string): string {
  return s.replace(/\\\n/g, "\n");
}

function toWords(input: string): string[] {
  try {
    return splitShell(stripTrailingBackslashes(input.trim()));
  } catch (e) {
    if (e instanceof ShellSyntaxError) {
      throw new CurlParseError({ message: e.message });
    }
    throw e;
  }
}

// Unsupported flags we tolerate, split by whether they take a value.
const UNKNOWN_TAKES_VALUE = new Set([
  "--connect-timeout", "--max-time", "--user-agent", "-A",
  "-o", "--output", "--cookie", "-b",
]);
const UNKNOWN_BARE = new Set([
  "--compressed", "-i", "--include", "--fail", "-f", "-S", "--show-error",
]);
