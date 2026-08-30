import type { FormDataEntry, RequestSpec } from "../types.ts";

const HEADER = `// Saved by postui — this file is the request; edit it freely.
// Values like $NAME resolve from the environment when the request is sent.`;

/**
 * Render a parsed request as a plain, executable TypeScript module: one
 * exported `request` object, no imports, no annotations to maintain. String
 * values are emitted verbatim from the parse, so $NAME environment
 * references survive untouched for resolution at send time.
 */
export function renderModule(spec: RequestSpec): string {
  const lines: string[] = [
    HEADER,
    "",
    "export const request = {",
    `  method: ${literal(spec.method)},`,
    `  url: ${literal(spec.url.href)},`,
  ];
  if (spec.headers.length === 0) {
    lines.push("  headers: {},");
  } else {
    lines.push("  headers: {");
    for (const [name, value] of spec.headers) {
      lines.push(`    ${literal(name)}: ${literal(value)},`);
    }
    lines.push("  },");
  }
  lines.push(`  body: ${renderBody(spec.body)},`);
  lines.push("};", "");
  return lines.join("\n");
}

/** A TS-safe string literal (JSON escapes are valid TypeScript strings). */
function literal(value: string): string {
  return JSON.stringify(value);
}

function renderBody(body: RequestSpec["body"]): string {
  if (body.kind === "none") return "null";
  if (body.kind === "raw") return literal(body.text);
  return renderFormEntries(body.entries);
}

function renderFormEntries(entries: FormDataEntry[]): string {
  if (entries.length === 0) return "[]";
  const rows = entries.map(e =>
    e.kind === "file"
      ? `    { name: ${literal(e.name)}, file: ${literal(e.path)} },`
      : `    { name: ${literal(e.name)}, value: ${literal(e.value)} },`,
  );
  return ["[", ...rows, "  ]"].join("\n");
}
