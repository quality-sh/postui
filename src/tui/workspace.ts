import { Data } from "effect";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SavedModuleError, loadRequests } from "../gen/load.ts";
import type { LoadedRequest } from "../gen/load.ts";

/** The requests folder could not be read at all (permissions, not a directory). */
export class WorkspaceReadError extends Data.TaggedError("WorkspaceReadError")<{
  message: string;
}> {}

/**
 * Read the workspace's saved requests, fresh — every single time.
 *
 * The parsing itself always goes through the shared loader
 * (`loadRequests` from src/gen/load.ts; the folder is the only input and
 * no parsing is duplicated here). The snapshot dance below exists because
 * of one runtime fact: Bun caches module evaluations per absolute path for
 * the whole process lifetime, and `loadRequests` imports each module by its
 * real path. Re-importing a hand-edited module therefore returns the copy
 * from the first import (probed on Bun 1.3: query strings, hash fragments
 * and re-pointed symlinks all normalize back to the cached module), which
 * would make refresh-on-focus lie about edits.
 *
 * So each read copies the folder's `.ts` files into a throwaway snapshot
 * directory — module identities Bun has never seen — loads THAT through the
 * shared loader, and deletes the snapshot. The folder on disk stays the
 * source of truth; the snapshot is a cache-buster, not a fork.
 */
export async function readWorkspace(requestsDir: string): Promise<LoadedRequest[]> {
  let names: string[];
  try {
    names = (await readdir(requestsDir)).filter(name => name.endsWith(".ts"));
  } catch (cause) {
    if (isMissingEntry(cause)) return []; // no requests folder yet — same as the loader's view
    throw new WorkspaceReadError({
      message: `cannot read requests folder ${requestsDir}: ${messageOf(cause)}`,
    });
  }
  if (names.length === 0) return [];

  const snapshot = await mkdtemp(join(tmpdir(), "postui-requests-"));
  try {
    await Promise.all(names.map(name => snapshotCopy(requestsDir, snapshot, name)));
    const loaded = await loadRequests(snapshot);
    // Point every request back at the real file so previews read (and
    // errors name) the user's actual paths, not the snapshot's.
    return loaded.map(request => ({ ...request, path: join(requestsDir, `${request.name}.ts`) }));
  } catch (cause) {
    if (cause instanceof SavedModuleError) {
      // surface the named loader error against the real folder, not /tmp
      throw new SavedModuleError({ message: cause.message.replaceAll(snapshot, requestsDir) });
    }
    throw cause;
  } finally {
    await rm(snapshot, { recursive: true, force: true });
  }
}

/** Copy one module into the snapshot; a file deleted mid-read is just absent. */
async function snapshotCopy(fromDir: string, toDir: string, name: string): Promise<void> {
  try {
    await copyFile(join(fromDir, name), join(toDir, name));
  } catch (cause) {
    if (isMissingEntry(cause)) return;
    throw new WorkspaceReadError({
      message: `cannot read saved request ${join(fromDir, name)}: ${messageOf(cause)}`,
    });
  }
}

function isMissingEntry(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause &&
    (cause as { code?: unknown }).code === "ENOENT";
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
