// @provenance rule: rule_docs_folder_only
// @provenance rule: rule_docs_read_only
// @provenance rule: rule_docs_deleted_gone
// @provenance rule: rule_docs_no_store
import { Data } from "effect";
import { mkdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { writeFileAtomic } from "../fs/atomic.ts";
import { loadRequests } from "../gen/load.ts";
import { renderDocs } from "./render.ts";

export class DocsOutError extends Data.TaggedError("DocsOutError")<
  { message: string }
> {}

export interface DocsOptions {
  /** Workspace root holding requests/. Defaults to cwd. */
  root?: string;
  /** Output directory for the document. Defaults to <root>/docs. */
  out?: string | null;
}

export interface DocsResult {
  /** Path of the written document, relative to root; null when there was nothing to document. */
  file: string | null;
}

const REQUESTS_DIR = "requests";
const DEFAULT_DOCS_DIR = "docs";
const DOCS_FILE = "API.md";

/**
 * Regenerate the API document from the requests folder: load every saved
 * request, render the whole document, create the output directory if
 * missing, and publish it through a temp file and rename. Everything that
 * can fail — module loading, rendering — happens before the first write, so
 * an existing document is either fully replaced or left byte-for-byte as it
 * was.
 */
export async function generateDocs(opts: DocsOptions = {}): Promise<DocsResult> {
  const root = opts.root ?? process.cwd();
  const requestsDir = join(root, REQUESTS_DIR);
  // --out resolves against the workspace root, like every other postui path,
  // never against the process's current directory.
  const outDir = resolve(root, opts.out ?? DEFAULT_DOCS_DIR);
  assertOutsideRequests(outDir, requestsDir);

  const requests = await loadRequests(requestsDir);
  if (requests.length === 0) return { file: null };

  const content = renderDocs(requests);
  const dest = join(outDir, DOCS_FILE);
  await mkdir(outDir, { recursive: true });
  await writeFileAtomic(dest, content);
  return { file: relative(root, dest) };
}

/** The document may never be published into the folder it documents. */
function assertOutsideRequests(outDir: string, requestsDir: string): void {
  const out = resolve(outDir);
  const requests = resolve(requestsDir);
  if (out === requests || out.startsWith(requests + sep)) {
    throw new DocsOutError({
      message:
        `${outDir} is inside the requests folder — docs output can never ` +
        `be written into the requests folder it documents`,
    });
  }
}
