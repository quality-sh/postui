import { Data } from "effect";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isValidModuleName } from "../save/name.ts";

export class SavedModuleError extends Data.TaggedError("SavedModuleError")<
  { message: string }
> {}

export class UnknownRequestError extends Data.TaggedError("UnknownRequestError")<
  { message: string }
> {}

/**
 * The shape a saved request module exports. This mirrors what `postui save`
 * emits; hand edits must still satisfy it for generation to proceed.
 */
interface SavedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body:
    | null
    | string
    | Array<{ name: string; value?: string; file?: string }>;
}

export interface LoadedRequest {
  /** Module name without extension, as saved. */
  name: string;
  /** Absolute path of the module file. */
  path: string;
  request: SavedRequest;
}

/**
 * Read the requests folder: every top-level .ts file is imported and its
 * `request` export validated. The folder is the only input; a file that
 * does not load or does not export a well-formed request is a named error,
 * so a bad module stops generation before anything is written.
 */
export async function loadRequests(dir: string): Promise<LoadedRequest[]> {
  const files = await listTsFiles(dir);
  return Promise.all(files.map(file => loadOne(dir, file)));
}

/**
 * Load exactly one saved request by module name. The name must be a safe
 * plain filename (no traversal); a module that does not exist is an
 * UnknownRequestError, one that does not load or export a well-formed
 * request is a SavedModuleError. Send reads only its own module, so a
 * broken sibling request never blocks an unrelated send.
 */
export async function loadRequestByName(dir: string, name: string): Promise<LoadedRequest> {
  if (!isValidModuleName(name)) {
    throw new UnknownRequestError({
      message: `no saved request named "${name}" in ${dir}/`,
    });
  }
  const path = join(dir, `${name}.ts`);
  try {
    await stat(path);
  } catch {
    throw new UnknownRequestError({ message: `no saved request named "${name}" in ${dir}/` });
  }
  return loadOne(dir, `${name}.ts`);
}

/**
 * Top-level .ts file names in the requests folder, sorted; [] when the
 * folder does not exist. Names only — symlinks are followed by the import,
 * and anything else that cannot load surfaces as a SavedModuleError.
 */
async function listTsFiles(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir);
    return names.filter(name => name.endsWith(".ts")).toSorted();
  } catch {
    return []; // no requests folder yet — nothing to generate from
  }
}

async function loadOne(dir: string, file: string): Promise<LoadedRequest> {
  const path = join(dir, file);
  let mod: unknown;
  try {
    mod = await import(pathToFileURL(path).href);
  } catch (cause) {
    throw new SavedModuleError({
      message: `${path} does not load: ${messageOf(cause)}`,
    });
  }
  const exported = (mod as Record<string, unknown>)["request"];
  if (exported === undefined) {
    throw new SavedModuleError({
      message: `${path} does not export a request — expected \`export const request\``,
    });
  }
  return { name: file.slice(0, -3), path, request: asSavedRequest(exported, path) };
}

function asSavedRequest(value: unknown, path: string): SavedRequest {
  if (typeof value !== "object" || value === null) {
    throw malformed(path, "request must be an object");
  }
  const r = value as Record<string, unknown>;
  if (typeof r["method"] !== "string") {
    throw malformed(path, "request.method must be a string");
  }
  if (typeof r["url"] !== "string") {
    throw malformed(path, "request.url must be a string");
  }
  return {
    method: r["method"],
    url: r["url"],
    headers: asHeaders(r["headers"], path),
    body: asBody(r["body"], path),
  };
}

function asHeaders(value: unknown, path: string): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw malformed(path, "request.headers must be an object");
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== "string") {
      throw malformed(path, `header "${name}" must be a string`);
    }
    headers[name] = headerValue;
  }
  return headers;
}

function asBody(value: unknown, path: string): SavedRequest["body"] {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) {
    throw malformed(path, "request.body must be null, a string, or an array of form entries");
  }
  return value.map(entry => asFormEntry(entry, path));
}

function asFormEntry(value: unknown, path: string): { name: string; value?: string; file?: string } {
  if (typeof value !== "object" || value === null) {
    throw malformed(path, "each form entry must be an object");
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry["name"] !== "string") {
    throw malformed(path, "each form entry needs a string name");
  }
  const hasValue = typeof entry["value"] === "string";
  const hasFile = typeof entry["file"] === "string";
  if (!hasValue && !hasFile) {
    throw malformed(path, `form entry "${entry["name"]}" needs a string value or file`);
  }
  if (hasValue && hasFile) {
    throw malformed(path, `form entry "${entry["name"]}" cannot have both value and file`);
  }
  return {
    name: entry["name"],
    ...(hasValue ? { value: entry["value"] as string } : {}),
    ...(hasFile ? { file: entry["file"] as string } : {}),
  };
}

function malformed(path: string, detail: string): SavedModuleError {
  return new SavedModuleError({ message: `${path} is malformed: ${detail}` });
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
