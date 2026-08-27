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

/**
 * Parse a curl command into a RequestSpec.
 *
 * Accepts either:
 *   - a full shell string: `curl -X POST https://x.io -H 'A: b' -d '{"k":1}'`
 *   - pre-split argv without the leading `curl` (as from process.argv)
 */
export function parseCurl(input: string | string[]): Parsed {
  const words =
    typeof input === "string"
      ? (() => {
          try {
            return splitShell(stripTrailingBackslashes(input.trim()));
          } catch (e) {
            if (e instanceof ShellSyntaxError) {
              throw new CurlParseError({ message: e.message });
            }
            throw e;
          }
        })()
      : input.slice();

  // Drop a leading "curl" if present.
  let idx = 0;
  if (words[0] === "curl") idx = 1;

  let method: string | null = null;
  let url: URL | null = null;
  const headers: Array<[string, string]> = [];
  const formEntries: FormDataEntry[] = [];
  const dataChunks: Array<{ text: string; urlencode: boolean }> = [];
  const warnings: ParseWarning[] = [];

  // Consume one flag value starting at idx+1, advancing idx past both.
  const takeValue = (flag: string): string => {
    const v = words[idx + 1];
    if (v === undefined || v.startsWith("-")) {
      throw new CurlParseError({ message: `flag ${flag} requires a value` });
    }
    idx += 2;
    return v;
  };

  while (idx < words.length) {
    const word = words[idx]!;

    if (word === "-X" || word === "--request") {
      method = takeValue(word).toUpperCase();
    } else if (word === "-H" || word === "--header") {
      const raw = takeValue(word);
      const sep = raw.indexOf(":");
      if (sep === -1) {
        throw new CurlParseError({ message: `invalid header: "${raw}"` });
      }
      headers.push([raw.slice(0, sep).trim(), raw.slice(sep + 1).trim()]);
    } else if (
      word === "-d" ||
      word === "--data" ||
      word === "--data-raw" ||
      word === "--data-binary"
    ) {
      dataChunks.push({ text: takeValue(word), urlencode: false });
    } else if (word === "--data-urlencode") {
      dataChunks.push({ text: takeValue(word), urlencode: true });
    } else if (word === "-F" || word === "--form") {
      const raw = takeValue(word);
      const eq = raw.indexOf("=");
      if (eq === -1) {
        throw new CurlParseError({ message: `invalid form field: "${raw}"` });
      }
      const name = raw.slice(0, eq);
      const value = raw.slice(eq + 1);
      formEntries.push(
        value.startsWith("@")
          ? { kind: "file", name, path: value.slice(1) }
          : { kind: "field", name, value },
      );
    } else if (word === "-u" || word === "--user") {
      headers.push(["Authorization", `Basic ${btoa(takeValue(word))}`]);
    } else if (word === "--url") {
      url = parseUrl(takeValue(word));
    } else if (IGNORED_FLAGS[word]) {
      warnings.push({ flag: word, message: IGNORED_FLAGS[word]! });
      idx++;
    } else if (UNKNOWN_TAKES_VALUE.has(word)) {
      warnings.push({ flag: word, message: "unsupported flag ignored" });
      idx += 2;
    } else if (UNKNOWN_BARE.has(word)) {
      warnings.push({ flag: word, message: "unsupported flag ignored" });
      idx++;
    } else if (word.startsWith("-")) {
      throw new CurlParseError({ message: `unknown curl flag: ${word}` });
    } else {
      if (url) {
        warnings.push({
          flag: word,
          message: "extra positional argument ignored",
        });
      } else {
        url = parseUrl(word);
      }
      idx++;
    }
  }

  if (!url) throw new CurlParseError({ message: "no URL found in curl command" });

  return {
    spec: buildSpec(method, url, headers, dataChunks, formEntries),
    warnings,
  };
}

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
    const text = dataChunks.map(c => c.text).join("&");
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
  if (body.kind === "raw" && !finalHeaders.has("Content-Type") && body.contentType) {
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

// Unsupported flags we tolerate, split by whether they take a value.
const UNKNOWN_TAKES_VALUE = new Set([
  "--connect-timeout", "--max-time", "--user-agent", "-A",
  "-o", "--output", "--cookie", "-b",
]);
const UNKNOWN_BARE = new Set([
  "--compressed", "-i", "--include", "--fail", "-f", "-S", "--show-error",
]);
