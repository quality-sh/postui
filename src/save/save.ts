import { Data } from "effect";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCurl } from "../curl/parse.ts";
import type { ParseWarning } from "../types.ts";
import { redactCredentialLiterals } from "./credentials.ts";
import { renderModule } from "./emitter.ts";
import { resolveModuleName } from "./name.ts";

export class SaveCollisionError extends Data.TaggedError("SaveCollisionError")<
  { message: string }
> {}

export interface SaveOptions {
  /** Requests folder. Defaults to "requests" in the working directory. */
  dir?: string;
  /** Module name from --name; derived from the URL when null. */
  name?: string | null;
  /** Replace an existing module instead of failing. */
  force?: boolean;
}

export interface SaveResult {
  path: string;
  name: string;
  content: string;
  /** Labels for each credential-like literal value that was dropped. */
  redacted: string[];
  /** Parse warnings for the caller to print. */
  warnings: ParseWarning[];
}

/**
 * Save a curl command as one executable TypeScript module at
 * <dir>/<name>.ts. The file is created only after the curl input parses;
 * a failure anywhere leaves the requests folder untouched, and an existing
 * module is replaced only when force is set.
 */
export async function saveRequest(
  input: string,
  opts: SaveOptions = {},
): Promise<SaveResult> {
  const target = opts.dir ?? "requests";
  const { spec, warnings } = parseCurl(input);
  const name = resolveModuleName({ flag: opts.name ?? null, url: spec.url });
  const { spec: clean, redacted } = redactCredentialLiterals(spec);
  const path = join(target, `${name}.ts`);

  if (!opts.force && (await exists(path))) {
    throw new SaveCollisionError({
      message: `${path} already exists — pass --force to replace it`,
    });
  }

  const content = renderModule(clean);
  await mkdir(target, { recursive: true });
  await writeFile(path, content, "utf8");
  return { path, name, content, redacted, warnings };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
