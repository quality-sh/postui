import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RGBA } from "@opentui/core";
import type { TestRendererSetup } from "@opentui/core/testing";
import { manualClock, setFxClock, type ManualClock } from "../src/tui/fx/clock.ts";
import { JSON_COLORS, THEME } from "../src/tui/theme.ts";
import { focusComposer, HEIGHT, moduleSource, openFirstRequest, setupApp, teardownApps } from "./helpers/tui-app.ts";
import { arrows, pressCtrl, settle } from "./helpers/composer-input.ts";
import { bgAt, is, locate } from "./helpers/composer-cells.ts";
import { flatSpans, frameText } from "./helpers/tui-capture.ts";

/**
 * Every composer key visibly lands (rule_tui_input_acknowledged): the
 * method blooms into its colour, a tab switch develops its content in,
 * rows arrive and leave with a pulse, and ctrl+s always answers with a
 * toast. Motion is watched on a manual fx clock.
 */

let restoreClock: (() => void) | null = null;

function watchMotion(): ManualClock {
  const clock = manualClock();
  restoreClock = setFxClock(clock);
  return clock;
}

afterEach(() => {
  restoreClock?.();
  restoreClock = null;
});

afterAll(async () => {
  await teardownApps();
});

const hex = (color: string): RGBA => RGBA.fromHex(color);

/** The span showing exactly `text` in the composer's send row (the method pill). */
function methodSpan(setup: TestRendererSetup, text: string): { fg: RGBA; bg: RGBA } | undefined {
  const row = setup.captureSpans().lines.find(line => line.spans.some(span => span.text.includes("▾")));
  return row?.spans.find(span => span.text.trim() === text);
}

describe("method cycle", () => {
  test("the new method blooms from fog into its own colour while the pill swells", async () => {
    const app = await setupApp({ "one.ts": moduleSource("GET", "https://api.dev/one") });
    await openFirstRequest(app);
    await focusComposer(app);
    await arrows(app, "up"); // URL → METHOD
    const clock = watchMotion();
    await arrows(app, "right"); // GET → POST
    await app.renderOnce();
    const start = methodSpan(app, "POST");
    expect(start?.fg.equals(hex(THEME.color.fog))).toBe(true);
    clock.advance(96);
    await app.renderOnce();
    const mid = methodSpan(app, "POST");
    expect(mid?.fg.equals(hex(THEME.color.gold))).toBe(false);
    expect(mid?.bg.equals(hex(THEME.color.accentSoft))).toBe(false); // the swell, off its rest fill
    clock.advance(400);
    await app.renderOnce();
    const settled = methodSpan(app, "POST");
    expect(settled?.fg.equals(hex(THEME.color.gold))).toBe(true);
    expect(settled?.bg.equals(hex(THEME.color.accentSoft))).toBe(true); // METHOD has the keys
  });
});

describe("tab switch", () => {
  test("the content develops in: a mid-reveal frame differs from the settled one", async () => {
    const app = await setupApp({
      "one.ts": moduleSource("GET", "https://api.dev/one", { headers: { accept: "application/json" } }),
    });
    await openFirstRequest(app);
    await focusComposer(app);
    await arrows(app, "down"); // URL → tab strip (BODY)
    const clock = watchMotion();
    await arrows(app, "left", "left"); // BODY → HEADERS → PARAMS
    await arrows(app, "right"); // → HEADERS
    await app.renderOnce();
    expect(frameText(app, HEIGHT)).not.toContain("accept: application/json"); // fog first
    clock.advance(70);
    await app.renderOnce();
    const mid = frameText(app, HEIGHT);
    clock.advance(200);
    await app.renderOnce();
    const settled = frameText(app, HEIGHT);
    expect(settled).toContain("accept: application/json");
    expect(mid).not.toBe(settled);
  });
});

describe("rows", () => {
  test("a new row swells in; ctrl+d pulses the slot it leaves", async () => {
    const app = await setupApp({
      "one.ts": moduleSource("GET", "https://api.dev/one", { headers: { accept: "*/*" } }),
    });
    await openFirstRequest(app);
    await focusComposer(app);
    await arrows(app, "down", "left", "down", "down"); // HEADERS, past `accept` onto the add row
    const clock = watchMotion();
    await app.mockInput.typeText("x");
    await app.renderOnce();
    expect(frameText(app, HEIGHT)).not.toMatch(/▸ x ?: /); // developing from fog
    clock.advance(400);
    await app.renderOnce();
    expect(frameText(app, HEIGHT)).toMatch(/▸ x ?: /); // the cursor block sits after the x
    const slot = locate(app, "▸ x");
    await pressCtrl(app, "d");
    await app.renderOnce();
    expect(frameText(app, HEIGHT)).not.toMatch(/x ?: /);
    clock.advance(96); // near the swell's peak
    await app.renderOnce();
    const far = slot.col + 30; // past the text: the row's own fill
    const mid = bgAt(app, slot.row, far);
    expect(is(mid, THEME.color.accentSoft) || is(mid, THEME.color.panel)).toBe(false);
    clock.advance(400);
    await app.renderOnce();
    expect(is(bgAt(app, slot.row, far), THEME.color.accentSoft)).toBe(true); // the cursor's row, at rest
  });
});

describe("save acknowledgements", () => {
  test("a save toasts and the ● fades out instead of vanishing", async () => {
    const app = await setupApp({ "one.ts": moduleSource("GET", "https://api.dev/one") });
    await openFirstRequest(app);
    await focusComposer(app);
    await app.mockInput.typeText("/two");
    const clock = watchMotion();
    await pressCtrl(app, "s");
    await settle(app);
    expect(frameText(app, HEIGHT)).toContain("one.ts ●"); // still there, fading
    clock.advance(600);
    await settle(app);
    const text = frameText(app, HEIGHT);
    expect(text).not.toContain("one.ts ●");
    expect(text).toContain("✓ saved one.ts");
    expect(app.shell.composer.edited).toBe(false);
  });

  test("a refused save toasts the reason in love", async () => {
    const app = await setupApp({ "one.ts": moduleSource("GET", "https://api.dev/one") });
    await openFirstRequest(app);
    await focusComposer(app);
    await arrows(app, "down", "right", "down"); // AUTH add row
    await app.mockInput.typeText("Bearer literal-secret");
    await pressCtrl(app, "s");
    await settle(app);
    const text = frameText(app, HEIGHT);
    expect(text).toContain("✗ not saved: Authorization holds a literal credential");
    const mark = flatSpans(app).find(span => span.text.includes("✗"));
    expect(mark?.fg.equals(hex(THEME.color.love))).toBe(true);
  });

  test("a save with nothing changed still answers, and writes nothing", async () => {
    const original = moduleSource("GET", "https://api.dev/one");
    const app = await setupApp({ "one.ts": original });
    await openFirstRequest(app);
    await focusComposer(app);
    await pressCtrl(app, "s");
    await settle(app);
    expect(frameText(app, HEIGHT)).toContain("no changes to save");
    expect(await readFile(join(app.requestsDir, "one.ts"), "utf8")).toBe(original);
  });
});

describe("body editor", () => {
  test("a JSON body is coloured by token kind, text and cursor exact", async () => {
    const app = await setupApp({
      "note.ts": moduleSource("POST", "https://api.dev/notes", { body: '{"name": "Ada", "age": 36}' }),
    });
    await openFirstRequest(app);
    await focusComposer(app);
    await arrows(app, "down", "down"); // into the body, cursor at 0
    const text = frameText(app, HEIGHT);
    expect(text).toContain(' 1  {"name": "Ada", "age": 36}'); // as typed, never re-laid out
    const spans = flatSpans(app);
    const colorOf = (needle: string): { equals(v: unknown): boolean } | undefined => spans.find(span => span.text === needle)?.fg;
    expect(colorOf('"Ada"')?.equals(hex(JSON_COLORS.string))).toBe(true);
    expect(colorOf("36")?.equals(hex(JSON_COLORS.number))).toBe(true);
    expect(colorOf('"name"')?.equals(hex(JSON_COLORS.key))).toBe(true);
    const cursor = spans.find(span => span.text === "{");
    expect(cursor?.bg.equals(hex(THEME.color.accent))).toBe(true); // the block cursor on the first char
    const gutter = spans.find(span => span.text.includes(" 1 "));
    expect(gutter?.bg.equals(hex(THEME.color.element))).toBe(true);
  });
});
