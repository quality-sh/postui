import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { manualClock, setFxClock, type ManualClock } from "../src/tui/fx/clock.ts";
import { MIN_BUSY_MS } from "../src/tui/send-lifecycle.ts";
import { THEME } from "../src/tui/theme.ts";
import {
  focusComposer,
  HEIGHT,
  moduleSource,
  openFirstRequest,
  serve,
  setupApp,
  teardownApps,
} from "./helpers/tui-app.ts";
import type { AppSetup } from "./helpers/tui-app.ts";
import { flatSpans, frameText, rowContaining } from "./helpers/tui-capture.ts";

/**
 * The send lifecycle, watched frame by frame on a manual fx clock: the busy
 * view at t=0, the minimum busy hold, the develop reveal, and the per-send
 * stamp that makes a repeat send look new (rule_tui_input_acknowledged).
 */

let restoreClock: (() => void) | null = null;

/** Run fx on a clock the test moves by hand (after setupApp's instant clock). */
function useManualClock(): ManualClock {
  const clock = manualClock(1000);
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

const BODY = JSON.stringify({ user: { id: 7, name: "Ada", roles: ["admin", "ops"] }, ok: true });

/** A stub that answers at once: a nested JSON object, or a 404 on /missing. */
function stub(): ReturnType<typeof serve> {
  return serve(req =>
    new URL(req.url).pathname === "/missing"
      ? Response.json({ error: "no such user" }, { status: 404 })
      : new Response(BODY, { headers: { "content-type": "application/json" } }),
  );
}

async function appFor(url: string): Promise<AppSetup> {
  const app = await setupApp({ "get-user.ts": moduleSource("GET", url) });
  await openFirstRequest(app);
  await focusComposer(app);
  return app;
}

/** Press Enter in the composer and let the send itself finish (the fx clock stays put). */
async function send(app: AppSetup): Promise<void> {
  app.mockInput.pressEnter();
  await app.flush();
  await app.shell.composer.settled();
  await app.renderOnce();
}

/** Move the fx clock and paint the frame at the new time. */
async function advance(app: AppSetup, clock: ManualClock, ms: number): Promise<string> {
  clock.advance(ms);
  await app.renderOnce();
  return frameText(app, HEIGHT);
}

/** The frame with its clock stamps (HH:MM:SS) blanked, for comparisons across seconds. */
const unclocked = (frame: string): string => frame.replaceAll(/\d\d:\d\d:\d\d/g, "--:--:--");

describe("send lifecycle", () => {
  test("t=0: the header spins with GET /path and a live ms count; the body is skeleton fog", async () => {
    const server = serve(async () => {
      await Bun.sleep(80);
      return new Response(BODY);
    });
    const app = await appFor(server.url("/users/7?full=1"));
    const clock = useManualClock();
    app.mockInput.pressEnter();
    await app.flush();
    await app.renderOnce();
    const header = rowContaining(app, "RESPONSE") ?? "";
    expect(header).toMatch(/[·∙•●]{4} GET \/users\/7\?full=1 +0 ms/);
    const frame = frameText(app, HEIGHT);
    expect(frame).not.toContain("sending…\n"); // no static placeholder…
    expect(rowContaining(app, "BODY  HEADERS  TESTS")).not.toBeNull();
    const fog = frame.split("\n").filter(row => /│ [·∙•]{12,}/.test(row.slice(30)));
    expect(fog.length).toBeGreaterThan(2); // …but skeleton rows of fog dots
    expect(rowContaining(app, "sending GET /users/7?full=1")).not.toBeNull(); // the live slot
    // The count ticks on the fx clock without a pane rebuild.
    await advance(app, clock, 120);
    expect(rowContaining(app, "RESPONSE")).toMatch(/GET \/users\/7\?full=1 +120 ms/);
    await app.shell.composer.settled();
    await advance(app, clock, 1000);
    server.close();
  });

  test("a result that lands instantly still holds the busy view for the minimum time", async () => {
    const server = stub();
    const app = await appFor(server.url("/users/7"));
    const clock = useManualClock();
    await send(app); // the stub has answered; the fx clock has not moved
    expect(rowContaining(app, "RESPONSE")).toMatch(/GET \/users\/7 +0 ms/);
    await advance(app, clock, MIN_BUSY_MS - 1);
    expect(rowContaining(app, "200 OK")).toBeNull(); // still busy at 219 ms
    await advance(app, clock, 1);
    expect(rowContaining(app, "200 OK")).not.toBeNull(); // settled at 220 ms
    await advance(app, clock, 1000);
    server.close();
  });

  test("the body develops in: a mid-develop frame differs from the settled one, which is the plain block", async () => {
    const server = stub();
    const app = await appFor(server.url("/users/7"));
    const clock = useManualClock();
    await send(app);
    await advance(app, clock, MIN_BUSY_MS);
    const mid = await advance(app, clock, 120);
    const settled = await advance(app, clock, 1000);
    expect(mid).not.toBe(settled);
    expect(mid).toMatch(/[·∙•●]/); // halftone cells still resolving
    expect(settled).toContain(" 1  {");
    expect(settled).toContain("\"name\": \"Ada\",");
    expect(clock.pending()).toBe(0); // nothing left ticking once settled
    // The settled view is the static code block: send again on the instant path…
    server.close();
  });

  test("↑/↓ scroll the body while it develops and after it settles", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `l${String(i + 1).padStart(2, "0")}`);
    const server = serve(() => new Response(lines.join("\n")));
    const app = await appFor(server.url("/long"));
    const clock = useManualClock();
    await send(app);
    await advance(app, clock, MIN_BUSY_MS + 40); // developing
    app.mockInput.pressTab(); // composer → response
    await app.flush();
    app.mockInput.pressArrow("down");
    app.mockInput.pressArrow("down");
    await app.flush();
    expect(app.shell.response.scrollTop).toBe(2);
    await advance(app, clock, 1000); // settles, keeping the reader's place
    expect(app.shell.response.scrollTop).toBe(2);
    expect(frameText(app, HEIGHT)).toContain(" 3  l03");
    app.mockInput.pressArrow("down");
    await app.flush();
    expect(app.shell.response.scrollTop).toBe(3);
    server.close();
  });

  test("HEADERS develops on its first show after a send", async () => {
    const server = stub();
    const app = await appFor(server.url("/users/7"));
    const clock = useManualClock();
    await send(app);
    await advance(app, clock, 2000);
    app.mockInput.pressTab();
    await app.flush();
    app.mockInput.pressArrow("right"); // BODY → HEADERS
    await app.flush();
    const first = await advance(app, clock, 60);
    const settled = await advance(app, clock, 1000);
    expect(settled).toContain("content-type: application/json");
    expect(first).not.toContain("content-type: application/json");
    server.close();
  });

  test("two identical sends paint different screens: #N and the time stamp the header", async () => {
    const server = stub();
    const app = await appFor(server.url("/users/7"));
    const clock = useManualClock();
    await send(app);
    const first = await advance(app, clock, 2000);
    await send(app);
    const busy = frameText(app, HEIGHT);
    const second = await advance(app, clock, 2000);
    expect(busy).not.toBe(first); // the keypress visibly landed at once
    expect(first).toMatch(/200 OK │ \d+ ms │ \d+ B │ #1 · \d\d:\d\d:\d\d/);
    expect(second).toMatch(/200 OK │ \d+ ms │ \d+ B │ #2 · \d\d:\d\d:\d\d/);
    expect(unclocked(second)).not.toBe(unclocked(first));
    server.close();
  });

  test("the status bar's live slot settles on a coloured dot, status, ms, size and #N", async () => {
    const server = stub();
    const app = await appFor(server.url("/missing"));
    const clock = useManualClock();
    await send(app);
    await advance(app, clock, 2000);
    const bar = frameText(app, HEIGHT).split("\n").at(-1) ?? "";
    expect(bar).toMatch(/● 404 · \d+ms · \d+B · #1\s*$/);
    const love = RGBA.fromHex(THEME.color.love);
    expect(flatSpans(app).some(span => span.text === "●" && span.fg.equals(love))).toBe(true);
    // A rejected send develops its body like any other, under a love chip.
    expect(frameText(app, HEIGHT)).toContain("\"error\": \"no such user\"");
    const chip = flatSpans(app).find(span => span.text === "404 NOT FOUND");
    expect(chip?.fg.equals(love)).toBe(true);
    server.close();
  });

  test("a transport failure takes the same path in love and raises a toast", async () => {
    const server = serve(() => new Response(""));
    const url = server.url("/gone");
    server.close(); // nothing listens there now: connection refused
    const app = await appFor(url);
    const clock = useManualClock();
    await send(app);
    expect(rowContaining(app, "GET /gone")).not.toBeNull(); // busy first
    await advance(app, clock, 2000);
    const frame = frameText(app, HEIGHT);
    expect(frame).toMatch(/✗ error │ #1 · \d\d:\d\d:\d\d/);
    expect(frame).toMatch(/✗ error: /); // the toast, top right
    expect(frame).toMatch(/● error · #1\s*$/);
    const love = RGBA.fromHex(THEME.color.love);
    expect(flatSpans(app).some(span => span.text.startsWith("error: ") && span.fg.equals(love))).toBe(true);
  });
});
