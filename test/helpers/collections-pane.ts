import type { RGBA } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCollectionsPane } from "../../src/tui/collections.ts";
import type { CollectionsPane } from "../../src/tui/collections.ts";
import { manualClock, setFxClock } from "../../src/tui/fx/clock.ts";
import type { ManualClock } from "../../src/tui/fx/clock.ts";
import type { WorkspaceReader } from "../../src/tui/workspace.ts";
import { flatSpans } from "./tui-capture.ts";

/**
 * The collections pane alone (no shell) on a temp requests folder, with a
 * manual fx clock: tests watch its motion frame by frame and drive exactly
 * one thing at a time.
 */

export const PANE_HEIGHT = 20;

export function moduleSource(method: string, url: string): string {
  return `export const request = { method: "${method}", url: "${url}", headers: {}, body: null };\n`;
}

export const WORKSPACE = {
  "create-user.ts": moduleSource("POST", "https://api.dev/users"),
  "list-users.ts": moduleSource("GET", "https://api.dev/users"),
  "health.ts": moduleSource("GET", "https://api.dev/health"),
};

export interface PaneSetup extends TestRendererSetup {
  readonly collections: CollectionsPane;
  readonly clock: ManualClock;
  readonly dir: string;
  /** How many sends Enter asked for. */
  readonly sends: () => number;
}

const dirs: string[] = [];
const setups: TestRendererSetup[] = [];
const restores: (() => void)[] = [];

/** Start the pane on `files`; `reader` swaps the folder reader (default: the real one). */
export async function setupPane(
  files: Record<string, string>,
  reader?: (dir: string) => WorkspaceReader,
): Promise<PaneSetup> {
  const clock = manualClock();
  restores.push(setFxClock(clock));
  const dir = await mkdtemp(join(tmpdir(), "postui-collections-pane-"));
  dirs.push(dir);
  await Promise.all(Object.entries(files).map(([name, content]) => writeFile(join(dir, name), content)));
  const setup = await createTestRenderer({ width: 40, height: PANE_HEIGHT });
  setups.push(setup);
  let sends = 0;
  const collections = startCollectionsPane(setup.renderer, {
    requestsDir: dir,
    ...(reader === undefined ? {} : { workspace: reader(dir) }),
    onOpen: () => {},
    onSend: () => {
      sends += 1;
      return true;
    },
  });
  setup.renderer.root.add(collections.pane);
  return { ...setup, collections, clock, dir, sends: () => sends };
}

/** Put the clock back after each test (the pane keeps the clock it started with). */
export function restorePaneClock(): void {
  for (const restore of restores.toReversed()) restore();
  restores.length = 0;
}

export async function teardownPanes(): Promise<void> {
  restorePaneClock();
  for (const setup of setups) setup.renderer.destroy();
  setups.length = 0;
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
}

/** The background under the row that holds `needle`'s text. */
export function bgUnder(setup: TestRendererSetup, needle: string): RGBA | undefined {
  return flatSpans(setup).find(span => span.text.includes(needle))?.bg as RGBA | undefined;
}

/** Re-render until `ready()` holds (real I/O the test cannot await, such as fs.watch). */
export async function waitUntil(setup: TestRendererSetup, ready: () => boolean, tries = 300): Promise<void> {
  await setup.renderOnce();
  if (ready()) return;
  if (tries === 0) throw new Error("condition never held");
  await Bun.sleep(10);
  await waitUntil(setup, ready, tries - 1);
}
