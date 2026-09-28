import { afterAll, describe, expect, test } from "bun:test";
import type { TextRenderable } from "@opentui/core";
import type { RowSlot } from "../src/tui/collections-slot.ts";
import { HEIGHT, moduleSource, setupApp, teardownApps } from "./helpers/tui-app.ts";
import type { AppSetup } from "./helpers/tui-app.ts";
import { frameText, rowContaining } from "./helpers/tui-capture.ts";

afterAll(teardownApps);

/** At HEIGHT 30 the pane body starts under the header (3 rows) and the pane's top frame. */
const BODY_TOP = 4;
/** Body rows: 30 - header (3) - status bar (1) - the pane's frame (2). */
const VISIBLE = 24;

/** `count` requests named `<prefix>01…` under one collection (`/<path>` → its title). */
function group(prefix: string, path: string, count: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let index = 1; index <= count; index += 1) {
    files[`${prefix}${String(index).padStart(2, "0")}.ts`] = moduleSource("GET", `https://api.dev/${path}`);
  }
  return files;
}

/** The pane's body rows as text (inside its frame). */
function bodyRows(app: AppSetup): string[] {
  // One char frame per call: this runs on every step of the walks below.
  return app.captureCharFrame().split("\n").slice(BODY_TOP, BODY_TOP + VISIBLE).map(line => [...line].slice(1, 29).join(""));
}

async function press(app: AppSetup, key: "j" | "k", times = 1): Promise<void> {
  app.mockInput.pressKeys(Array.from({ length: times }, () => key));
  await app.flush();
  await app.renderOnce();
}

/** Press `key` `times` times, running `each` after every step (one keypress, one frame). */
async function walk(app: AppSetup, key: "j" | "k", times: number, each: () => void): Promise<void> {
  if (times === 0) return;
  await press(app, key);
  each();
  await walk(app, key, times - 1, each);
}

/** Each slot's text renderable (the row's only child while no reveal runs). */
function texts(slots: readonly RowSlot[]): TextRenderable[] {
  return slots.map(slot => slot.box.getChildren()[0] as TextRenderable);
}

describe("collections scroll window", () => {
  test("long lists scroll: the window follows the highlight under a pinned header", async () => {
    const app = await setupApp(group("req", "users", 30));
    // One header plus 23 one-row requests fill the 24-row window.
    expect(frameText(app, HEIGHT)).toContain("req23");
    expect(frameText(app, HEIGHT)).not.toContain("req24");
    await press(app, "j", 24);
    const rows = bodyRows(app);
    expect(rowContaining(app, "▌")).toContain("req25");
    expect(rows.join("\n")).not.toContain("req01"); // scrolled out of the window
    expect(rows[0]).toStartWith("▾ Users"); // the group's header stays pinned over its rows
    expect(rows[1]).toContain("req03");
  });

  test("a group header never scrolls away from its rows, down or back up", async () => {
    const app = await setupApp({ ...group("a", "alpha", 10), ...group("b", "beta", 10), ...group("g", "gamma", 10) });
    // Down to the last request, then back up to the first: the window's top
    // row is always a header, pinned or real, and a group's first request
    // always shows its own header right above it.
    const check = (): void => {
      const rows = bodyRows(app);
      expect(rows[0]).toStartWith("▾ ");
      const at = rows.findIndex(line => line.includes("▌"));
      if (rows[at]?.includes("b01") === true) expect(rows[at - 1]).toStartWith("▾ Beta");
      if (rows[at]?.includes("a01") === true) expect(rows[at - 1]).toStartWith("▾ Alpha");
    };
    await walk(app, "j", 29, check);
    expect(rowContaining(app, "▌")).toContain("g10");
    await walk(app, "k", 29, check);
    expect(rowContaining(app, "▌")).toContain("a01");
  });

  test("↑/↓ repaints only the row it left and the row it landed on", async () => {
    const app = await setupApp(group("req", "users", 8));
    const slots = [...app.shell.collections.view.slots];
    const before = texts(slots).map(text => text.content);
    await press(app, "j");
    const after = texts(app.shell.collections.view.slots).map(text => text.content);
    // The same row renderables, in the same order: nothing was rebuilt.
    expect(app.shell.collections.view.slots).toEqual(slots);
    const repainted = after.flatMap((content, index) => (content === before[index] ? [] : [index]));
    expect(repainted).toEqual([1, 2]); // req01 lost the bar, req02 gained it (row 0 is the header)
  });

  test("scrolling reuses the pool: no row renderable is created or destroyed", async () => {
    const app = await setupApp(group("req", "users", 40));
    const slots = [...app.shell.collections.view.slots];
    expect(slots).toHaveLength(VISIBLE);
    await press(app, "j", 30);
    await press(app, "k", 30);
    await press(app, "k"); // wraps to the bottom: a full-window jump
    expect(app.shell.collections.view.slots).toEqual(slots);
    expect(slots.every(slot => !slot.box.isDestroyed)).toBe(true);
    expect(rowContaining(app, "▌")).toContain("req40");
  });
});
