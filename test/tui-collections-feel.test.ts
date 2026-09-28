import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import type { TestRendererSetup } from "@opentui/core/testing";
import { blendHex } from "../src/tui/motion.ts";
import { THEME } from "../src/tui/theme.ts";
import { workspaceReader } from "../src/tui/workspace.ts";
import type { WorkspaceReader } from "../src/tui/workspace.ts";
import {
  PANE_HEIGHT as HEIGHT,
  WORKSPACE,
  bgUnder,
  restorePaneClock,
  setupPane,
  teardownPanes,
} from "./helpers/collections-pane.ts";
import type { PaneSetup } from "./helpers/collections-pane.ts";
import { flatSpans, frameText } from "./helpers/tui-capture.ts";

/**
 * The collections pane's feel, watched frame by frame on a manual fx
 * clock: the skeleton before the first read, rows developing in, the Enter
 * pulse, and hover.
 */

/** A reader whose first scan waits for `open()`: the test decides when the read lands. */
function gatedReader(dir: string): { reader: WorkspaceReader; open(): void } {
  const real = workspaceReader(dir);
  const gate = Promise.withResolvers<void>();
  return { reader: { scan: async () => (await gate.promise, real.scan()) }, open: () => gate.resolve() };
}

/** Enter once, then watch the pulse: peak at once, still lit at 300 ms, settled by 500 ms. */
async function pressAndWatch(setup: PaneSetup): Promise<void> {
  const soft = RGBA.fromHex(THEME.color.accentSoft);
  const peak = RGBA.fromHex(blendHex(THEME.color.accentSoft, THEME.color.accent, 0.7));
  expect(setup.collections.handleKey({ name: "return", ctrl: false })).toBe(true);
  await setup.renderOnce();
  expect(bgUnder(setup, "create-user")?.equals(peak)).toBe(true);
  const bar = flatSpans(setup).find(span => span.text.includes("▌"));
  expect(bar?.fg.equals(RGBA.fromHex(THEME.color.text))).toBe(true);
  setup.clock.advance(300);
  await setup.renderOnce();
  expect(bgUnder(setup, "create-user")?.equals(soft)).toBe(false); // still lit at 300 ms
  setup.clock.advance(200);
  await setup.renderOnce();
  expect(bgUnder(setup, "create-user")?.equals(soft)).toBe(true);
}

const fogDots = (setup: TestRendererSetup): number =>
  flatSpans(setup).filter(span => /[·∙•]/.test(span.text) && span.fg.equals(RGBA.fromHex(THEME.color.fog))).length;

afterEach(restorePaneClock);
afterAll(teardownPanes);

describe("collections pane feel", () => {
  test("before the first read lands: skeleton fog rows, never the empty state", async () => {
    const gates: { open(): void }[] = [];
    const setup = await setupPane({}, dir => {
      const gated = gatedReader(dir);
      gates.push(gated);
      return gated.reader;
    });
    await setup.renderOnce();
    const text = frameText(setup, HEIGHT);
    expect(text).not.toContain("no saved requests");
    expect(fogDots(setup)).toBeGreaterThan(0);
    // The fog drifts while the read is out, and still never claims "empty".
    setup.clock.advance(800);
    await setup.renderOnce();
    expect(frameText(setup, HEIGHT)).not.toContain("no saved requests");
    for (const gate of gates) gate.open();
    await setup.collections.ready;
    await setup.renderOnce();
    // Only now, with the read in, is the empty workspace honestly empty.
    expect(frameText(setup, HEIGHT)).toContain("no saved requests");
    expect(fogDots(setup)).toBe(0);
  });

  test("the first listing develops in: fog first, then the rows, staggered", async () => {
    const setup = await setupPane(WORKSPACE);
    await setup.collections.ready;
    await setup.renderOnce();
    const slots = setup.collections.view.slots.filter(slot => slot.key !== "");
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every(slot => slot.developing)).toBe(true);
    expect(frameText(setup, HEIGHT)).not.toContain("create-user"); // still halftone
    setup.clock.advance(260);
    await setup.renderOnce();
    // Staggered: the top rows have landed while the lower ones still resolve.
    expect(slots[0]?.developing).toBe(false);
    expect(slots.at(-1)?.developing).toBe(true);
    setup.clock.advance(400);
    await setup.renderOnce();
    expect(slots.some(slot => slot.developing)).toBe(false);
    const text = frameText(setup, HEIGHT);
    for (const name of ["create-user", "list-users", "health"]) expect(text).toContain(name);
  });

  test("enter pulses the row's bar and fill for over 300 ms, every time", async () => {
    const setup = await setupPane(WORKSPACE);
    await setup.collections.ready;
    setup.clock.advance(1000); // the first listing's develop is done
    await setup.renderOnce();
    expect(bgUnder(setup, "create-user")?.equals(RGBA.fromHex(THEME.color.accentSoft))).toBe(true);
    await pressAndWatch(setup);
    // The same request again: the second press must land as visibly as the first.
    await pressAndWatch(setup);
    expect(setup.sends()).toBe(2);
  });

  test("hover swaps a row to elementHover; the selected row keeps accentSoft", async () => {
    const setup = await setupPane(WORKSPACE);
    await setup.collections.ready;
    setup.clock.advance(1000);
    await setup.renderOnce();
    const rows = frameText(setup, HEIGHT).split("\n");
    const listRow = rows.findIndex(line => line.includes("list-users"));
    const createRow = rows.findIndex(line => line.includes("create-user"));
    await setup.mockMouse.moveTo(12, listRow);
    await setup.renderOnce();
    expect(bgUnder(setup, "list-users")?.equals(RGBA.fromHex(THEME.color.elementHover))).toBe(true);
    await setup.mockMouse.moveTo(12, createRow); // the selected row (the first listing's highlight)
    await setup.renderOnce();
    expect(bgUnder(setup, "create-user")?.equals(RGBA.fromHex(THEME.color.accentSoft))).toBe(true);
    expect(bgUnder(setup, "list-users")?.equals(RGBA.fromHex(THEME.color.elementHover))).toBe(false);
  });
});
