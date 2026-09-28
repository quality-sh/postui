import { afterAll, describe, expect, test } from "bun:test";
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
import { arrows, pressCtrl, settle } from "./helpers/composer-input.ts";
import { frameText, rowContaining } from "./helpers/tui-capture.ts";

const CANARY = "rows-secret-5d1c";

afterAll(async () => {
  await teardownApps();
});

/** From the URL: down to the strip, step to `tab` (BODY is the default), into the rows. */
async function openTab(app: AppSetup, tab: "params" | "headers" | "auth"): Promise<void> {
  await arrows(app, "down");
  const steps = { params: ["left", "left"], headers: ["left"], auth: ["right"] } as const;
  await arrows(app, ...steps[tab], "down");
}

describe("composer rows: HEADERS, PARAMS, AUTH", () => {
  test("a header value edits in place and reaches the wire", async () => {
    let accept = "";
    const server = serve(req => {
      accept = req.headers.get("accept") ?? "";
      return new Response("{}", { status: 200 });
    });
    const app = await setupApp({
      "one.ts": moduleSource("GET", server.url("/"), { headers: { accept: "text/plain" } }),
    });
    await openFirstRequest(app);
    await focusComposer(app);
    await openTab(app, "headers");
    app.mockInput.pressKey("END"); // end of the name
    await arrows(app, "right"); // crosses into the value
    app.mockInput.pressKey("END");
    await app.mockInput.typeText(";q=1"); // "q" types, never quits
    await app.flush();
    expect(rowContaining(app, "▸ accept: text/plain;q=1")).not.toBeNull();
    app.mockInput.pressEnter(); // enter sends from a row
    await settle(app);
    expect(accept).toBe("text/plain;q=1");
    server.close();
  });

  test("typing into the trailing add row creates a header; ctrl+d removes it", async () => {
    let seen = "";
    const server = serve(req => {
      seen = req.headers.get("x-trace") ?? "(none)";
      return new Response("{}", { status: 200 });
    });
    const app = await setupApp({
      "one.ts": moduleSource("GET", server.url("/")),
    });
    await openFirstRequest(app);
    await focusComposer(app);
    await openTab(app, "headers");
    expect(frameText(app, HEIGHT)).toContain("▸ "); // the cursor starts on the add row
    await app.mockInput.typeText("x-trace");
    await arrows(app, "right"); // name → value
    await app.mockInput.typeText("abc");
    await app.flush();
    expect(frameText(app, HEIGHT)).toContain("x-trace: abc");
    expect(frameText(app, HEIGHT)).toContain("+ add header"); // a fresh add row below
    app.mockInput.pressEnter();
    await settle(app);
    expect(seen).toBe("abc");
    await pressCtrl(app, "d");
    await app.renderOnce();
    expect(frameText(app, HEIGHT)).not.toContain("x-trace");
    app.mockInput.pressEnter();
    await settle(app);
    expect(seen).toBe("(none)");
    server.close();
  });

  test("backspace on an emptied row removes it", async () => {
    const app = await setupApp({
      "one.ts": moduleSource("GET", "https://api.dev/one", { headers: { ab: "c" } }),
    });
    await openFirstRequest(app);
    await focusComposer(app);
    await openTab(app, "headers");
    app.mockInput.pressKey("END");
    await arrows(app, "right");
    app.mockInput.pressKey("END");
    for (let i = 0; i < 5; i += 1) app.mockInput.pressBackspace(); // "c", into the name, "b", "a", remove
    await app.flush();
    expect(frameText(app, HEIGHT)).not.toContain("ab:");
    expect(app.shell.composer.edited).toBe(true);
  });

  test("PARAMS rows write the URL's query, and URL edits show up as rows", async () => {
    const app = await setupApp({
      "list.ts": moduleSource("GET", "http://a.io/u?limit=5"),
    });
    await openFirstRequest(app);
    await focusComposer(app);
    await app.mockInput.typeText("&page=2"); // typed into the URL
    await app.flush();
    await openTab(app, "params");
    let text = frameText(app, HEIGHT);
    expect(text).toContain("limit = 5");
    expect(text).toContain("page = 2");
    await arrows(app, "down", "down"); // to the add row
    await app.mockInput.typeText("q");
    await arrows(app, "right");
    await app.mockInput.typeText("$SEARCH"); // env refs survive: no percent-encoding
    await app.flush();
    text = frameText(app, HEIGHT);
    expect(text).toContain("http://a.io/u?limit=5&page=2&q=$SEARCH");
    await arrows(app, "up", "up"); // back to limit
    await pressCtrl(app, "d");
    await app.renderOnce();
    expect(frameText(app, HEIGHT)).toContain("http://a.io/u?page=2&q=$SEARCH");
  });

  test("AUTH: a typed credential shows only its env reference, a literal only as •", async () => {
    const app = await setupApp({
      "one.ts": moduleSource("GET", "https://api.dev/one"),
    });
    await openFirstRequest(app);
    await focusComposer(app);
    await openTab(app, "auth");
    await app.mockInput.typeText("Bearer $API_TOKEN"); // the add row starts in the value
    await app.flush();
    expect(frameText(app, HEIGHT)).toContain("Authorization: •••••• $API_TOKEN");
    await arrows(app, "down"); // leave the row: at rest it is the fixed marker
    expect(frameText(app, HEIGHT)).toContain("Authorization: [redacted] ← $API_TOKEN");
    await arrows(app, "down"); // (clamped to the add row)
    await app.mockInput.typeText(CANARY);
    await app.flush();
    const text = frameText(app, HEIGHT);
    expect(text).not.toContain(CANARY);
    expect(text).toContain("•".repeat(CANARY.length));
    // the HEADERS tab shows the same rows, just as redacted
    await arrows(app, "up", "up", "left", "left"); // rows → strip → BODY → HEADERS
    expect(frameText(app, HEIGHT)).toContain("+ add header");
    expect(frameText(app, HEIGHT)).not.toContain(CANARY);
    expect(frameText(app, HEIGHT)).toContain("literal — will not save");
  });
});
