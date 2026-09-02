import { afterAll, describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import {
  focusComposer,
  focusResponse,
  HEIGHT,
  openFirstRequest,
  serve,
  setupApp,
  teardownApps,
} from "./helpers/tui-app.ts";
import { flatSpans, frameText, rowContaining } from "./helpers/tui-capture.ts";
import { THEME } from "../src/tui/theme.ts";

/** A minimal saved-request module body. */
const mod = (method: string, url: string): string =>
  `export const request = { method: "${method}", url: "${url}", headers: {}, body: null };\n`;

afterAll(async () => {
  await teardownApps();
});

describe("visual polish", () => {
  test("the halftone dot field renders as dim braille spans in the header and empty rail", async () => {
    const app = await setupApp(); // empty workspace: the rail is one big empty region
    const dim = RGBA.fromHex(THEME.color.dim);
    const braille = /[\u2800-\u28ff]/;
    const dots = flatSpans(app).filter(span => braille.test(span.text));
    expect(dots.length).toBeGreaterThan(0); // dots exist…
    for (const dot of dots) {
      expect(dot.fg.equals(dim)).toBe(true); // …all in the dim decoration tone
    }
  });

  test("every pane's empty state speaks the shared style: text for the lack, dim for the hint", async () => {
    const app = await setupApp();
    const text = RGBA.fromHex(THEME.color.text);
    const dim = RGBA.fromHex(THEME.color.dim);
    const spans = flatSpans(app);

    // collections: the lack in text, the fix-it command bright
    const lack = spans.find(span => span.text.includes("no saved requests found"));
    expect(lack?.fg.equals(text)).toBe(true);

    // composer: same structure (main line + dim way out)
    const composerEmpty = spans.find(span => span.text.includes("no request loaded"));
    expect(composerEmpty?.fg.equals(text)).toBe(true);
    const composerHint = spans.find(span => span.text.includes("select one in collections"));
    expect(composerHint?.fg.equals(dim)).toBe(true);

    // response idle: same structure again
    const responseEmpty = spans.find(span => span.text.includes("no response yet"));
    expect(responseEmpty?.fg.equals(text)).toBe(true);
    const responseHint = spans.find(span =>
      span.text.includes("select a request in collections and press ⏎"),
    );
    expect(responseHint?.fg.equals(dim)).toBe(true);
  });

  test("the response tests-tab empty state marks the way out in bright", async () => {
    const app = await setupApp({ "one.ts": mod("GET", "https://api.dev/one") });
    await openFirstRequest(app);
    await focusComposer(app);
    await focusResponse(app);
    app.mockInput.pressKey("l"); // HEADERS
    await app.flush();
    app.mockInput.pressKey("l"); // TESTS
    await app.flush();
    await app.shell.response.settled();
    await app.renderOnce();
    const bright = RGBA.fromHex(THEME.color.bright);
    const gen = flatSpans(app).find(span => span.text.includes("run postui gen"));
    expect(gen?.fg.equals(bright)).toBe(true);
  });

  test("a failed workspace read renders its named error with the accent ✗ marker", async () => {
    const app = await setupApp({ "broken.ts": "export const request = {" });
    const accent = RGBA.fromHex(THEME.color.accent);
    const marker = flatSpans(app).find(span => span.text.includes("✗"));
    expect(marker).toBeDefined();
    expect(marker?.fg.equals(accent)).toBe(true);
    expect(frameText(app, HEIGHT)).toContain("SavedModuleError");
  });

  test("the status bar shows the key map while browsing", async () => {
    const app = await setupApp({ "one.ts": mod("GET", "https://api.dev/one") });
    const bar = rowContaining(app, "j/k navigate");
    expect(bar).toContain("tab focus");
    expect(bar).toContain("⏎ send");
    expect(bar).toContain("/ search");
    expect(bar).toContain("q quit");
  });

  test("the status bar switches to the send-in-flight mode while a send runs", async () => {
    const server = serve(async () => {
      await Bun.sleep(120);
      return new Response("{}", { status: 200 });
    });
    const app = await setupApp({ "slow.ts": mod("GET", server.url("/")) });
    await openFirstRequest(app);
    await focusComposer(app);
    app.mockInput.pressEnter(); // starts the send
    await app.flush();
    await app.renderOnce();
    const inFlight = rowContaining(app, "⏎ sending…"); // the bar's send cell…
    expect(inFlight).not.toBeNull(); // …names the mode…
    // …in the accent color, not the muted label tone. (The response pane
    // also shows a bare dim "sending…" — the bar's chunk is " sending…".)
    const accent = RGBA.fromHex(THEME.color.accent);
    const cell = flatSpans(app).find(span => span.text === " sending…");
    expect(cell?.fg.equals(accent)).toBe(true);
    await app.shell.composer.settled();
    await app.renderOnce();
    expect(rowContaining(app, "j/k navigate")).not.toBeNull(); // …and hands it back
    server.close();
  });
});
