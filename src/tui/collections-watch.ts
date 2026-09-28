import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";

/**
 * Watch the requests folder for edits made outside the TUI (an editor, a
 * `postui save` in another terminal, git): any event schedules one
 * `onChange`, debounced so an editor's write-rename-chmod burst — or a
 * checkout touching every file — costs one rescan. The rescan itself is
 * cheap (a stat per file, imports only for what changed; see
 * workspace.ts), so the watcher only has to say "look", never "what".
 *
 * A folder that does not exist yet cannot be watched; `arm()` tries again
 * (the pane calls it after each scan), so the watch starts once the first
 * save creates the folder. Watch errors (the folder deleted under us) drop
 * the watcher the same way. Timers are real and unref'd: this is I/O, not
 * animation, so it never runs on the fx clock and never holds the process.
 */

/** Quiet time after the last event before the rescan runs. */
const DEBOUNCE_MS = 90;

export interface FolderWatch {
  /** Start watching when not already (idempotent; a missing folder is retried next time). */
  arm(): void;
  /** Stop for good: no more events, no pending rescan. */
  close(): void;
}

export function watchFolder(dir: string, onChange: () => void, debounceMs = DEBOUNCE_MS): FolderWatch {
  let watcher: FSWatcher | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const schedule = (): void => {
    if (closed) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!closed) onChange();
    }, debounceMs);
    timer.unref();
  };

  const drop = (): void => {
    watcher?.close();
    watcher = null;
  };

  return {
    arm() {
      if (closed || watcher !== null) return;
      try {
        watcher = watch(dir, { persistent: false }, schedule);
      } catch {
        return; // no folder yet (or not watchable): the next arm retries
      }
      watcher.on("error", () => {
        drop();
        schedule(); // the rescan says what happened, and re-arms if it can
      });
    },
    close() {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      drop();
    },
  };
}
