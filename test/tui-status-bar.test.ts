import { afterAll, describe, expect, test } from "bun:test";
import { BoxRenderable, RGBA, StyledText, TextRenderable, fg } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { hintsFor } from "../src/tui/keymap.ts";
import { clearChildren } from "../src/tui/render.ts";
import { STATUS_BAR_ROWS, startStatusBar } from "../src/tui/status-bar.ts";
import { THEME } from "../src/tui/theme.ts";
import { flatSpans, frameText } from "./helpers/tui-capture.ts";
import { HEIGHT, setupApp, teardownApps } from "./helpers/tui-app.ts";

const WIDTH = 80;

const setups: TestRendererSetup[] = [];

/** A status bar alone on a one-row renderer. */
async function renderBar(): Promise<{ setup: TestRendererSetup; bar: ReturnType<typeof startStatusBar> }> {
  const setup = await createTestRenderer({ width: WIDTH, height: STATUS_BAR_ROWS });
  setups.push(setup);
  const bar = startStatusBar(setup.renderer);
  setup.renderer.root.add(bar.pane);
  bar.paint("browsing", hintsFor("collections"));
  await setup.renderOnce();
  return { setup, bar };
}

afterAll(async () => {
  for (const setup of setups) setup.renderer.destroy();
  await teardownApps();
});

describe("status bar", () => {
  test("one row, no frame and no cells: the hints are key + label, two spaces apart", async () => {
    expect(STATUS_BAR_ROWS).toBe(1);
    const { setup } = await renderBar();
    const row = frameText(setup, 1);
    expect(row).toContain("↑↓ select  ⏎ send  tab focus  / search  ^n import  q quit");
    expect(row).not.toMatch(/[│─╭╮╰╯┌┐└┘]/);
    const spans = flatSpans(setup);
    expect(spans.find(span => span.text === "↑↓")?.fg.equals(RGBA.fromHex(THEME.color.text))).toBe(true);
    expect(spans.find(span => span.text.startsWith(" select"))?.fg.equals(RGBA.fromHex(THEME.color.muted))).toBe(true);
  });

  test("the whole app's bar is its last row, directly under the panes", async () => {
    const app = await setupApp();
    const rows = frameText(app, HEIGHT).split("\n");
    expect(rows.at(-1)).toContain("↑↓ select");
    expect(rows.at(-2)).toMatch(/^╰─+╯╰─+╯$/); // the panes' bottom edges, then the bar
  });

  test("setStatus writes the live slot at the right edge and null clears it", async () => {
    const { setup, bar } = await renderBar();
    bar.setStatus("GET /users 42 ms");
    await setup.renderOnce();
    const row = frameText(setup, 1);
    expect(row.trimEnd().endsWith("GET /users 42 ms")).toBe(true);
    expect(row).toContain("↑↓ select"); // the hints keep their side
    bar.setStatus(new StyledText([fg(THEME.color.love)("✗ failed")]));
    await setup.renderOnce();
    expect(flatSpans(setup).find(span => span.text.includes("✗ failed"))?.fg.equals(RGBA.fromHex(THEME.color.love))).toBe(true);
    bar.setStatus(null);
    await setup.renderOnce();
    expect(frameText(setup, 1)).not.toContain("failed");
  });

  test("setIndicator mounts a renderable beside the status; replacing it destroys the old one", async () => {
    const { setup, bar } = await renderBar();
    const first = new TextRenderable(setup.renderer, { content: "◐" });
    bar.setIndicator(first);
    bar.setStatus("sending");
    await setup.renderOnce();
    expect(frameText(setup, 1).trimEnd().endsWith("◐ sending")).toBe(true);
    // A repaint for a focus move leaves the live slot alone.
    bar.paint("browsing", hintsFor("response"));
    await setup.renderOnce();
    expect(frameText(setup, 1)).toContain("◐ sending");
    const second = new TextRenderable(setup.renderer, { content: "◓" });
    bar.setIndicator(second);
    await setup.renderOnce();
    expect(first.isDestroyed).toBe(true);
    expect(frameText(setup, 1)).toContain("◓ sending");
    bar.setIndicator(null);
    await setup.renderOnce();
    expect(second.isDestroyed).toBe(true);
    expect(frameText(setup, 1)).not.toContain("◓");
  });

  test("the shell exposes the bar, so later waves can drive the live slot", async () => {
    const app = await setupApp();
    app.shell.statusBar.setStatus("#1 · 200 OK");
    await app.renderOnce();
    expect(frameText(app, HEIGHT).split("\n").at(-1)).toContain("#1 · 200 OK");
  });
});

describe("clearChildren", () => {
  test("destroys what it removes: a repaint never leaves detached renderables behind", async () => {
    const setup = await createTestRenderer({ width: 10, height: 2 });
    setups.push(setup);
    const box = new BoxRenderable(setup.renderer, { flexDirection: "column" });
    const inner = new BoxRenderable(setup.renderer, {});
    const text = new TextRenderable(setup.renderer, { content: "x" });
    inner.add(text);
    box.add(inner);
    clearChildren(box);
    expect(box.getChildren()).toHaveLength(0);
    expect(inner.isDestroyed).toBe(true);
    expect(text.isDestroyed).toBe(true); // recursively
  });
});
