import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import type { SendResult } from "../src/send/send.ts";
import { startComposerPane } from "../src/tui/composer.ts";
import { MIN_BUSY_MS } from "../src/tui/composer-run.ts";
import { manualClock, setFxClock, type ManualClock } from "../src/tui/fx/clock.ts";
import { spinnerFrame } from "../src/tui/fx/spinner.ts";
import { THEME } from "../src/tui/theme.ts";
import { focusComposer, moduleSource, openFirstRequest, serve, setupApp, teardownApps } from "./helpers/tui-app.ts";
import type { AppSetup } from "./helpers/tui-app.ts";
import { bgAt, is, locate } from "./helpers/composer-cells.ts";

/**
 * SEND lands: pressed pill + spinner from the keypress, a busy state held
 * for MIN_BUSY_MS on the fx clock however fast the response, a visible
 * refusal of a second send, and hover on the pills.
 */

const setups: TestRendererSetup[] = [];
let restoreClock: (() => void) | null = null;

/** Run fx on a manual clock from here on (after setupApp, which pins the instant one). */
function watchMotion(): ManualClock {
  const clock = manualClock();
  restoreClock = setFxClock(clock);
  return clock;
}

afterEach(() => {
  restoreClock?.();
  restoreClock = null;
  for (const setup of setups) setup.renderer.destroy();
  setups.length = 0;
});

afterAll(async () => {
  await teardownApps();
});

/** Let queued promise continuations run (no timers involved). */
const microtasks = (): Promise<void> => Bun.sleep(0);

describe("SEND feedback", () => {
  test("enter presses the pill at once and a halftone spinner takes its label", async () => {
    const server = serve(() => new Response("{}", { status: 200 }));
    const app = await setupApp({ "ping.ts": moduleSource("GET", server.url("/ping")) });
    await openFirstRequest(app);
    await focusComposer(app);
    const clock = watchMotion();
    app.mockInput.pressEnter();
    await app.flush();
    await app.renderOnce();
    const spinner = spinnerFrame(0, 5, { color: THEME.color.bg }).map(cell => cell.char).join("");
    const at = locate(app, spinner);
    expect(locate(app, "GET ▾").row).toBe(at.row); // in the send row, where SEND was
    expect(app.captureCharFrame()).not.toContain("SEND ");
    expect(is(bgAt(app, at.row, at.col), THEME.color.accent)).toBe(true); // pressed fill at t=0
    clock.advance(MIN_BUSY_MS);
    await app.shell.composer.settled();
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("SEND");
    expect(app.captureCharFrame()).toContain("200 OK");
    server.close();
  });

  test("a click on SEND sends", async () => {
    let hits = 0;
    const server = serve(() => {
      hits += 1;
      return new Response("{}", { status: 200 });
    });
    const app = await setupApp({ "ping.ts": moduleSource("GET", server.url("/ping")) });
    await openFirstRequest(app);
    const at = locate(app, "SEND");
    await app.mockMouse.click(at.col + 1, at.row);
    await app.flush();
    await app.shell.composer.settled();
    await app.renderOnce();
    expect(hits).toBe(1);
    expect(app.shell.focus.focused).toBe("composer"); // the click still focuses the pane
    server.close();
  });

  test("the pills swap to elementHover under the mouse", async () => {
    const app: AppSetup = await setupApp({ "ping.ts": moduleSource("GET", "https://api.dev/ping") });
    await openFirstRequest(app); // composer unfocused: every pill rests on element
    const send = locate(app, "SEND");
    const url = locate(app, "https://api.dev/ping");
    expect(is(bgAt(app, send.row, send.col), THEME.color.element)).toBe(true);
    await app.mockMouse.moveTo(send.col + 1, send.row);
    await app.renderOnce();
    expect(is(bgAt(app, send.row, send.col), THEME.color.elementHover)).toBe(true);
    await app.mockMouse.moveTo(url.col + 2, url.row);
    await app.renderOnce();
    expect(is(bgAt(app, send.row, send.col), THEME.color.element)).toBe(true);
    expect(is(bgAt(app, url.row, url.col), THEME.color.elementHover)).toBe(true);
  });
});

describe("minimum busy display", () => {
  interface Seen {
    sending: number;
    results: number;
    notes: string[];
  }

  /** A lone composer whose pipeline answers at once. */
  async function instantComposer(): Promise<{ setup: TestRendererSetup; composer: ReturnType<typeof startComposerPane>; seen: Seen }> {
    const setup = await createTestRenderer({ width: 90, height: 16 });
    setups.push(setup);
    const seen: Seen = { sending: 0, results: 0, notes: [] };
    const composer = startComposerPane(setup.renderer, {
      diagnostics: {
        showSending: () => (seen.sending += 1),
        showResult: () => (seen.results += 1),
        showError: () => (seen.results += 1),
        showNote: text => seen.notes.push(text),
      },
      sendDraft: async () => ({ result: {} as SendResult, latencyMs: 1 }),
    });
    setup.renderer.root.add(composer.pane);
    composer.load({
      name: "ping",
      path: "/nonexistent/ping.ts",
      request: { method: "GET", url: "https://api.dev/ping", headers: {}, body: null },
    });
    return { setup, composer, seen };
  }

  test("an instant response is held until MIN_BUSY_MS: pill and pane stay busy together", async () => {
    const clock = watchMotion();
    const { setup, composer, seen } = await instantComposer();
    expect(composer.send()).toBe(true);
    await microtasks();
    expect(seen.sending).toBe(1);
    expect(seen.results).toBe(0); // the pipeline answered; the result waits
    clock.advance(MIN_BUSY_MS - 1);
    await microtasks();
    await setup.renderOnce();
    expect(seen.results).toBe(0);
    expect(setup.captureCharFrame()).not.toContain("SEND"); // still the spinner
    clock.advance(1);
    await composer.settled();
    await setup.renderOnce();
    expect(seen.results).toBe(1);
    expect(setup.captureCharFrame()).toContain("SEND");
  });

  test("a second send in flight is refused visibly: a note and a love pulse on the pill", async () => {
    const clock = watchMotion();
    const { setup, composer, seen } = await instantComposer();
    composer.send();
    await setup.renderOnce();
    const at = locate(setup, spinnerFrame(0, 5).map(cell => cell.char).join(""));
    expect(composer.send()).toBe(false);
    expect(seen.notes).toEqual(["a send is already in flight — wait for it to finish"]);
    clock.advance(96); // near the swell's peak
    await setup.renderOnce();
    const mid = bgAt(setup, at.row, at.col);
    expect(is(mid, THEME.color.accent)).toBe(false);
    // The pulse leans toward love: more red than the accent has.
    expect((mid?.r ?? 0) > RGBA.fromHex(THEME.color.accent).r).toBe(true);
    clock.advance(MIN_BUSY_MS);
    await composer.settled();
    expect(seen.results).toBe(1); // the first send only
  });
});
