import { Data } from "effect";
import { copyFile, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SavedModuleError, loadRequests } from "../gen/load.ts";
import type { LoadedRequest } from "../gen/load.ts";

/** The requests folder could not be read at all (permissions, not a directory). */
export class WorkspaceReadError extends Data.TaggedError("WorkspaceReadError")<{
  message: string;
}> {}

/** One scan of the requests folder: the full list, and what moved since the last scan. */
export interface WorkspaceScan {
  /** Every saved request, in the loader's (filename) order. */
  readonly requests: LoadedRequest[];
  /** Modules imported by THIS scan: new files and files whose stamp changed. */
  readonly changed: readonly string[];
  /** Modules the previous scan had that are gone now. */
  readonly removed: readonly string[];
}

/** A folder reader that remembers what it loaded, so a rescan only imports what changed. */
export interface WorkspaceReader {
  scan(): Promise<WorkspaceScan>;
}

/** What identifies one version of a file on disk: a rewrite changes at least one field. */
interface Stamp {
  readonly mtimeNs: bigint;
  readonly size: bigint;
  readonly ino: bigint;
}

const sameStamp = (a: Stamp, b: Stamp): boolean =>
  a.mtimeNs === b.mtimeNs && a.size === b.size && a.ino === b.ino;

/**
 * Read the workspace's saved requests, re-importing only what changed.
 *
 * The parsing itself always goes through the shared loader
 * (`loadRequests` from src/gen/load.ts; no parsing is duplicated here).
 * Each scan lists the folder and stats every `.ts` file (mtime, size,
 * inode); a file whose stamp matches the last scan keeps its loaded
 * request, so a scan of an unchanged folder costs a readdir and some stats
 * and imports nothing.
 *
 * Changed files go through a snapshot, because of one runtime fact: Bun
 * caches module evaluations per absolute path for the whole process
 * lifetime, and `loadRequests` imports each module by its real path.
 * Re-importing a hand-edited module therefore returns the copy from the
 * first import (probed on Bun 1.3: query strings, hash fragments and
 * re-pointed symlinks all normalize back to the cached module). So the
 * changed files are copied into a throwaway directory — module identities
 * Bun has never seen — loaded from THERE through the shared loader, and
 * the directory is deleted. The folder on disk stays the source of truth.
 *
 * A scan that throws (a module that does not load) records nothing, so the
 * next scan tries the same files again.
 */
export function workspaceReader(requestsDir: string): WorkspaceReader {
  const known = new Map<string, { stamp: Stamp; request: LoadedRequest }>();
  return {
    async scan() {
      const names = await listModules(requestsDir);
      const stamps = await Promise.all(names.map(name => stampOf(join(requestsDir, name))));
      const changed: string[] = [];
      for (const [index, name] of names.entries()) {
        const stamp = stamps[index];
        const seen = known.get(name);
        if (stamp !== null && stamp !== undefined && (seen === undefined || !sameStamp(seen.stamp, stamp))) {
          changed.push(name);
        }
      }
      const loaded = await importFresh(requestsDir, changed);
      const listed = new Set(names);
      const removed = [...known.keys()].filter(name => !listed.has(name));
      for (const name of removed) known.delete(name);
      for (const [index, name] of names.entries()) {
        const request = loaded.get(name);
        const stamp = stamps[index];
        if (request !== undefined && stamp !== null && stamp !== undefined) known.set(name, { stamp, request });
      }
      const requests = names.flatMap(name => {
        const entry = known.get(name);
        return entry === undefined ? [] : [entry.request];
      });
      return {
        requests,
        changed: changed.filter(name => loaded.has(name)).map(moduleName),
        removed: removed.map(moduleName),
      };
    },
  };
}

/** Read the workspace once, fresh: every module imported. */
export async function readWorkspace(requestsDir: string): Promise<LoadedRequest[]> {
  return (await workspaceReader(requestsDir).scan()).requests;
}

/** The folder's `.ts` file names, sorted like the loader; [] when there is no folder yet. */
async function listModules(requestsDir: string): Promise<string[]> {
  try {
    return (await readdir(requestsDir)).filter(name => name.endsWith(".ts")).toSorted();
  } catch (cause) {
    if (isMissingEntry(cause)) return []; // no requests folder yet — same as the loader's view
    throw new WorkspaceReadError({
      message: `cannot read requests folder ${requestsDir}: ${messageOf(cause)}`,
    });
  }
}

/** A file's stamp, or null when it vanished between the listing and the stat. */
async function stampOf(path: string): Promise<Stamp | null> {
  try {
    const info = await stat(path, { bigint: true });
    return { mtimeNs: info.mtimeNs, size: info.size, ino: info.ino };
  } catch (cause) {
    if (isMissingEntry(cause)) return null;
    throw new WorkspaceReadError({ message: `cannot read saved request ${path}: ${messageOf(cause)}` });
  }
}

/** Import `files` through a snapshot; keyed by file name, pointed back at the real folder. */
async function importFresh(requestsDir: string, files: readonly string[]): Promise<Map<string, LoadedRequest>> {
  const out = new Map<string, LoadedRequest>();
  if (files.length === 0) return out;
  const snapshot = await mkdtemp(join(tmpdir(), "postui-requests-"));
  try {
    await Promise.all(files.map(name => snapshotCopy(requestsDir, snapshot, name)));
    for (const request of await loadRequests(snapshot)) {
      // Point every request back at the real file so previews read (and
      // errors name) the user's actual paths, not the snapshot's.
      out.set(`${request.name}.ts`, { ...request, path: join(requestsDir, `${request.name}.ts`) });
    }
    return out;
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

/** `create-user.ts` → `create-user`. */
function moduleName(file: string): string {
  return file.slice(0, -3);
}

function isMissingEntry(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause &&
    (cause as { code?: unknown }).code === "ENOENT";
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
