import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { RGBA, type TextRenderable } from "@opentui/core";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { COLLECTIONS_PANE_ID } from "../src/tui/collections.ts";
import { THEME } from "../src/tui/theme.ts";
import { workspaceReader } from "../src/tui/workspace.ts";
import type { WorkspaceScan } from "../src/tui/workspace.ts";
import {
  PANE_HEIGHT as HEIGHT,
  WORKSPACE,
  bgUnder,
  moduleSource,
  restorePaneClock,
  setupPane,
  teardownPanes,
  waitUntil,
} from "./helpers/collections-pane.ts";
import type { PaneSetup } from "./helpers/collections-pane.ts";
import { frameText, rowContaining } from "./helpers/tui-capture.ts";

/**
 * Change detection instead of reload-per-focus: a focus regain or a folder
 * event rescans (a stat per file), imports only what changed, and develops
 * only the changed rows in. A rescan that finds nothing paints nothing.
 */

afterEach(restorePaneClock);
afterAll(teardownPanes);

/** Start the pane on WORKSPACE and let the first listing's develop finish. */
async function settledPane(record?: WorkspaceScan[]): Promise<PaneSetup> {
  const setup = await setupPane(WORKSPACE, dir => {
    const real = workspaceReader(dir);
    return {
      scan: async () => {
        const scan = await real.scan();
        record?.push(scan);
        return scan;
      },
    };
  });
  await setup.collections.ready;
  setup.clock.advance(1000);
  await setup.renderOnce();
  return setup;
}

/** Each used slot's text content, by key (identity shows whether a row was repainted). */
function contents(setup: PaneSetup): Map<string, unknown> {
  const slots = setup.collections.view.slots.filter(slot => slot.key !== "");
  return new Map(slots.map(slot => [slot.key, (slot.box.getChildren()[0] as TextRenderable).content]));
}

const developing = (setup: PaneSetup): string[] =>
  setup.collections.view.slots.filter(slot => slot.developing).map(slot => slot.key);

describe("collections change detection", () => {
  test("a focus regain with nothing changed imports nothing and repaints nothing", async () => {
    const scans: WorkspaceScan[] = [];
    const setup = await settledPane(scans);
    const before = contents(setup);
    setup.collections.syncFocus(null);
    setup.collections.syncFocus(COLLECTIONS_PANE_ID);
    await setup.collections.settled();
    await setup.renderOnce();
    const last = scans.at(-1);
    expect(scans).toHaveLength(2); // the first listing, then the focus regain
    expect(last?.changed).toEqual([]);
    expect(last?.removed).toEqual([]);
    const after = contents(setup);
    for (const [key, content] of before) expect(after.get(key)).toBe(content);
    expect(developing(setup)).toEqual([]);
  });

  test("an edit made outside the TUI appears on its own, and only the changed rows develop in", async () => {
    const setup = await settledPane();
    await writeFile(join(setup.dir, "list-users.ts"), moduleSource("DELETE", "https://api.dev/users"));
    await writeFile(join(setup.dir, "orders.ts"), moduleSource("GET", "https://api.dev/orders"));
    // No focus change, no key: the folder watch notices by itself.
    await waitUntil(setup, () => developing(setup).includes("request:orders") && developing(setup).includes("request:list-users"));
    expect(developing(setup)).not.toContain("request:create-user");
    expect(developing(setup)).not.toContain("request:health");
    setup.clock.advance(1000);
    await setup.renderOnce();
    expect(rowContaining(setup, "list-users")).toContain("DEL");
    expect(frameText(setup, HEIGHT)).toContain("orders");
  });

  test("reveal highlights the named request and develops it in with a pulse", async () => {
    const setup = await settledPane();
    await writeFile(join(setup.dir, "import-me.ts"), moduleSource("PUT", "https://api.dev/users"));
    await setup.collections.reveal("import-me");
    await setup.renderOnce();
    expect(developing(setup)).toEqual(["request:import-me"]);
    // The fill under the row flashes toward the accent before it settles.
    setup.clock.advance(360);
    await setup.renderOnce();
    const soft = RGBA.fromHex(THEME.color.accentSoft);
    expect(bgUnder(setup, "import-me")?.equals(soft)).toBe(false);
    setup.clock.advance(400);
    await setup.renderOnce();
    expect(rowContaining(setup, "▌")).toContain("import-me");
    expect(bgUnder(setup, "import-me")?.equals(soft)).toBe(true);
  });

  test("a search re-rank reflows: rows that land in a new slot develop in, the rest hold still", async () => {
    const setup = await settledPane();
    setup.collections.beginFilter();
    setup.clock.advance(1000);
    await setup.renderOnce();
    const before = setup.collections.view.slots.map(slot => slot.key);
    setup.collections.setFilterQuery("health");
    await setup.renderOnce();
    const after = setup.collections.view.slots.map(slot => slot.key);
    const moved = after.filter((key, index) => key !== "" && key !== before[index]);
    expect(moved.length).toBeGreaterThan(0);
    expect(developing(setup)).toEqual(moved);
  });
});
