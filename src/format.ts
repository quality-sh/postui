import type { RequestSpec } from "./types.ts";

const METHOD_COLORS: Record<string, string> = {
  GET: "\x1b[32m",
  POST: "\x1b[33m",
  PUT: "\x1b[34m",
  PATCH: "\x1b[35m",
  DELETE: "\x1b[31m",
  HEAD: "\x1b[36m",
  OPTIONS: "\x1b[36m",
};
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

/** Compact single-line summary. */
function summarize(spec: RequestSpec): string {
  const color = METHOD_COLORS[spec.method] ?? "";
  return `${color}${BOLD}${spec.method}${RESET} ${spec.url}`;
}

/** Full structured view of a parsed request. */
export function display(spec: RequestSpec): string {
  const lines: string[] = [];
  lines.push(summarize(spec));
  lines.push("");

  lines.push(`${DIM}Headers${RESET}`);
  for (const [k, v] of spec.headers) {
    lines.push(`  ${k}: ${v}`);
  }
  if (spec.headers.length === 0) lines.push(`  ${DIM}(none)${RESET}`);

  lines.push("");
  if (spec.body.kind === "raw") {
    lines.push(`${DIM}Body${RESET} ${DIM}[${spec.body.contentType ?? "text/plain"}]${RESET}`);
    lines.push(indent(spec.body.text));
  } else if (spec.body.kind === "form") {
    lines.push(`${DIM}Body${RESET} ${DIM}[multipart/form-data]${RESET}`);
    for (const e of spec.body.entries) {
      if (e.kind === "file") {
        lines.push(`  ${e.name}: @${e.path}`);
      } else {
        lines.push(`  ${e.name}: ${e.value}`);
      }
    }
  } else {
    lines.push(`${DIM}Body${RESET} ${DIM}(none)${RESET}`);
  }

  return lines.join("\n");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map(l => `  ${l}`)
    .join("\n");
}
