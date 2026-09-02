import { afterAll, describe, expect, test } from "bun:test";
import { engine, RGBA } from "@opentui/core";
import {
  attachMotion,
  blendHex,
  detachMotion,
  settleBorder,
  sweepBorder,
} from "../src/tui/motion.ts";
import { COMPOSER_PANE_ID, RESPONSE_PANE_ID } from "../src/tui/shell.ts";
import { THEME } from "../src/tui/theme.ts";
import { frameText, rowContaining } from "./helpers/tui-capture.ts";
import {
  moduleSource,
  openFirstRequest,
  serve,
  setupApp,
  teardownApps,
  type AppSetup,
} from "./helpers/tui-app.ts";

const HEIGHT = 30;

/** The frame row containing `needle`, or null. */
function rowOf(setup: AppSetup, needle: string): string | null {
  return rowContaining(setup, needle);
}

/** The row index containing `needle`, or -1. */
function rowIndexOf(setup: AppSetup, needle: string): number {
  return frameText(setup, HEIGHT)
    .split("\n")
    .findIndex(line => line.includes(needle));
}

afterAll(async () => {
  await teardownApps();
});

describe("mouse interactivity", () => {
  test("clicking a request row moves the selection bar to it", async () => {
    const app = await setupApp({
      "alpha-check.ts": moduleSource("GET", "http://alpha.test/"),
      "beta-check.ts": moduleSource("POST", "http://beta.test/", { body: "x=1" }),
    });
    // Baseline: the bar (▶ marker) sits on the first request.
    expect(rowOf(app, "alpha-check") ?? "").toContain("▶");
    // The second request's text row, inside the collections pane.
    const betaRow = rowIndexOf(app, "beta-check");
    expect(betaRow).toBeGreaterThan(0);
    await app.mockMouse.click(5, betaRow);
    await app.flush();
    await app.renderOnce();
    expect(rowOf(app, "beta-check") ?? "").toContain("▶");
    expect(rowOf(app, "alpha-check") ?? "").not.toContain("▶");
  });

  test("clicking a pane focuses it (border treatment follows)", async () => {
    const app = await setupApp({
      "alpha-check.ts": moduleSource("GET", "http://alpha.test/"),
    });
    expect(app.shell.focus.focused).toBe("collections");
    const composerRow = rowIndexOf(app, "no request loaded");
    expect(composerRow).toBeGreaterThan(0);
    await app.mockMouse.click(60, composerRow);
    await app.flush();
    await app.renderOnce();
    expect(app.shell.focus.focused).toBe(COMPOSER_PANE_ID);
    const accent = RGBA.fromHex(THEME.color.accent);
    const muted = RGBA.fromHex(THEME.color.border);
    expect(app.shell.composer.pane.borderColor.equals(accent)).toBe(true);
    expect(app.shell.collections.pane.borderColor.equals(muted)).toBe(true);
    // Clicking the response pane moves focus on again.
    const responseRow = rowIndexOf(app, "no response yet");
    expect(responseRow).toBeGreaterThan(0);
    await app.mockMouse.click(60, responseRow);
    await app.flush();
    await app.renderOnce();
    expect(app.shell.focus.focused).toBe(RESPONSE_PANE_ID);
  });

  test("clicking a row while another pane is focused selects it AND refocuses collections", async () => {
    const app = await setupApp({
      "alpha-check.ts": moduleSource("GET", "http://alpha.test/"),
      "beta-check.ts": moduleSource("GET", "http://beta.test/"),
    });
    app.mockInput.pressTab();
    await app.flush();
    expect(app.shell.focus.focused).toBe(COMPOSER_PANE_ID);
    const betaRow = rowIndexOf(app, "beta-check");
    await app.mockMouse.click(5, betaRow);
    await app.flush();
    await app.shell.collections.settled();
    await app.renderOnce();
    expect(app.shell.focus.focused).toBe("collections");
    expect(rowOf(app, "beta-check") ?? "").toContain("▶");
  });
});

describe("enter sends the open request", () => {
  test("first enter opens, second enter sends through the pipeline", async () => {
    const server = serve(() => Response.json({ ok: true }));
    const app = await setupApp({
      "alpha-check.ts": moduleSource("GET", server.url()),
    });
    await openFirstRequest(app);
    // The composer now holds the request; enter again (collections still
    // focused) must SEND it, not reload it.
    app.mockInput.pressEnter();
    await app.flush();
    await app.shell.composer.settled();
    await app.renderOnce();
    expect(rowContaining(app, "200 OK")).not.toBeNull();
    expect(rowContaining(app, '{"ok":true}')).not.toBeNull();
    server.close();
  });

  test("enter on a not-yet-open request still opens (never sends blind)", async () => {
    const app = await setupApp({
      "alpha-check.ts": moduleSource("GET", "http://never-reached.test/"),
      "beta-check.ts": moduleSource("GET", "http://also-never.test/"),
    });
    await openFirstRequest(app); // alpha open; cursor on alpha
    app.mockInput.pressKeys(["J"]);
    await app.flush();
    await app.renderOnce();
    app.mockInput.pressEnter(); // beta: opens, cannot reach a server
    await app.flush();
    await app.shell.collections.settled();
    await app.renderOnce();
    // The composer re-titled to beta and no response appeared.
    expect(app.shell.composer.loadedName).toBe("beta-check");
    expect(rowContaining(app, "no response yet")).not.toBeNull();
  });
});

describe("motion primitives", () => {
  test("blendHex interpolates endpoints, midpoints and clamps", () => {
    expect(blendHex("#000000", "#ffffff", 0)).toBe("#000000");
    expect(blendHex("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(blendHex("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(blendHex("#f43f5e", "#f43f5e", 0.3)).toBe("#f43f5e");
    // t beyond [0,1] clamps.
    expect(blendHex("#102030", "#ffffff", -1)).toBe("#102030");
    expect(blendHex("#102030", "#ffffff", 9)).toBe("#ffffff");
    // Unparsable inputs fall back to an endpoint, never garbage.
    expect(blendHex("red", "#ffffff", 0.5)).toBe("red");
    expect(blendHex("red", "#ffffff", 1)).toBe("#ffffff");
  });

  test("sweepBorder without the motion engine lands the end color synchronously", async () => {
    const app = await setupApp();
    const pane = app.shell.response.pane;
    pane.borderColor = THEME.color.border;
    const animated = sweepBorder(pane, THEME.color.border, THEME.color.accent);
    expect(animated).toBe(false);
    expect(pane.borderColor.equals(RGBA.fromHex(THEME.color.accent))).toBe(true);
  });

  test("sweepBorder with the engine animates and settles on the end color", async () => {
    const app = await setupApp();
    const pane = app.shell.response.pane;
    pane.borderColor = THEME.color.border;
    const detach = attachMotion(app.renderer);
    try {
      const animated = sweepBorder(pane, THEME.color.border, THEME.color.accent);
      expect(animated).toBe(true);
      // No frame has run: the border is still where it started.
      expect(pane.borderColor.equals(RGBA.fromHex(THEME.color.border))).toBe(true);
      // Drive the timeline deterministically past its duration.
      engine.update(500);
      expect(pane.borderColor.equals(RGBA.fromHex(THEME.color.accent))).toBe(true);
    } finally {
      detachMotion();
      detach();
    }
  });

  test("settleBorder cancels a live sweep so its completion cannot repaint stale state", async () => {
    const app = await setupApp();
    const pane = app.shell.response.pane;
    pane.borderColor = THEME.color.border;
    const detach = attachMotion(app.renderer);
    try {
      expect(sweepBorder(pane, THEME.color.border, THEME.color.accent)).toBe(true);
      // Focus moved on before the sweep finished: recede pins the muted
      // border and cancels the timeline.
      settleBorder(pane, THEME.color.border);
      engine.update(500); // let the (cancelled) sweep's completion fire — it must not
      expect(pane.borderColor.equals(RGBA.fromHex(THEME.color.border))).toBe(true);
    } finally {
      detachMotion();
      detach();
    }
  });
});
