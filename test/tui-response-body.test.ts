import { afterAll, describe, expect, test } from "bun:test";
import { TUI_BODY_WINDOW } from "../src/tui/response-pane.ts";
import { RGBA } from "@opentui/core";
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
import { THEME } from "../src/tui/theme.ts";
import { flatSpans, frameText, rowContaining } from "./helpers/tui-capture.ts";

afterAll(async () => {
  await teardownApps();
});

/** Serve `body`, open the request, send it, settle. */
async function sendBody(
  body: string,
  init: ResponseInit = {},
): Promise<{ app: AppSetup; close: () => void }> {
  const server = serve(() => new Response(body, init));
  const app = await setupApp({ "probe.ts": moduleSource("GET", server.url("/")) });
  await openFirstRequest(app);
  await focusComposer(app);
  app.mockInput.pressEnter();
  await app.flush();
  await app.shell.composer.settled();
  await app.renderOnce();
  return { app, close: server.close };
}

/** Wheel down over `row` one notch at a time until `needle` shows; returns the notches used (capped). */
async function wheelUntil(app: AppSetup, row: number, needle: string, limit = 30): Promise<number> {
  if (limit === 0 || rowContaining(app, needle) !== null) return 0;
  await app.mockMouse.scroll(60, row, "down");
  await app.renderOnce();
  return 1 + (await wheelUntil(app, row, needle, limit - 1));
}

/** The color of the first span whose text is exactly `text`. */
function colorOf(app: AppSetup, text: string): RGBA | undefined {
  return flatSpans(app).find(span => span.text === text)?.fg as RGBA | undefined;
}

// The test app's response pane shows seven body lines; the bodies here are
// shaped to fit them (the block scrolls the rest).
describe("response body", () => {
  test("JSON bodies are pretty-printed, one member per line, under a numbered gutter", async () => {
    const { app, close } = await sendBody(`{"name":"Ada","n":1}`);
    const text = frameText(app, HEIGHT);
    expect(text).toContain("json object with 2 keys"); // the summary line stays
    expect(rowContaining(app, "1  {")).not.toBeNull();
    expect(rowContaining(app, "2    \"name\": \"Ada\",")).not.toBeNull();
    expect(rowContaining(app, "3    \"n\": 1")).not.toBeNull();
    expect(rowContaining(app, "4  }")).not.toBeNull();
    expect(text).not.toContain(`{"name":"Ada"`); // no raw compact line
    close();
  });

  test("nested containers indent one level per depth", async () => {
    const { app, close } = await sendBody(`[["x"],{}]`);
    expect(rowContaining(app, "2    [")).not.toBeNull();
    expect(rowContaining(app, "3      \"x\"")).not.toBeNull();
    close();
  });

  test("tokens are colored by kind: strings gold, keys body text, literals iris, punctuation dim", async () => {
    const gold = RGBA.fromHex(THEME.color.gold);
    const literal = RGBA.fromHex(THEME.color.iris);
    const text = RGBA.fromHex(THEME.color.text);
    const punct = RGBA.fromHex(THEME.color.dim);
    const object = await sendBody(`{"s":"str","n":42}`);
    expect(colorOf(object.app, "\"str\"")?.equals(gold)).toBe(true);
    expect(colorOf(object.app, "42")?.equals(literal)).toBe(true);
    // Keys share the indentation's color, so their span carries the indent.
    expect(colorOf(object.app, "  \"s\"")?.equals(text)).toBe(true);
    expect(colorOf(object.app, ":")?.equals(punct)).toBe(true);
    expect(colorOf(object.app, "{")?.equals(punct)).toBe(true);
    object.close();
    const array = await sendBody(`[false,null]`);
    expect(colorOf(array.app, "false")?.equals(literal)).toBe(true);
    expect(colorOf(array.app, "null")?.equals(literal)).toBe(true);
    array.close();
  });

  test("a truncated JSON excerpt is laid out up to the cut, with the truncation note", async () => {
    // Whitespace between tokens pushes the rest past the TUI's 64 KiB window.
    const body = `{"id":"usr_01",${" ".repeat(TUI_BODY_WINDOW + 300)}"after":"cut-away-9d2"}`;
    const { app, close } = await sendBody(body);
    const text = frameText(app, HEIGHT);
    expect(text).toContain(`showing first ${TUI_BODY_WINDOW} of`); // the note survives
    expect(rowContaining(app, "1  {")).not.toBeNull();
    expect(rowContaining(app, "2    \"id\": \"usr_01\",")).not.toBeNull();
    expect(colorOf(app, "…")?.equals(RGBA.fromHex(THEME.color.dim))).toBe(true); // the cut marker
    expect(text).not.toContain("cut-away-9d2"); // nothing past the window
    close();
  });

  test("a cut inside a string keeps the partial string, colored as a string", async () => {
    const { app, close } = await sendBody(JSON.stringify({ pad: "p".repeat(TUI_BODY_WINDOW + 400) }));
    expect(rowContaining(app, "2    \"pad\": \"ppp")).not.toBeNull();
    const cut = flatSpans(app).find(span => span.text.startsWith("\"ppp"));
    expect(cut?.fg.equals(RGBA.fromHex(THEME.color.gold))).toBe(true);
    close();
  });

  test("a body taller than the pane scrolls with the mouse wheel, never grows the pane", async () => {
    const keys = "abcdefghijklmnopqrstuvwxyz".split("");
    const { app, close } = await sendBody(JSON.stringify(Object.fromEntries(keys.map((key, i) => [key, i + 1]))));
    expect(rowContaining(app, "\"a\": 1")).not.toBeNull();
    expect(rowContaining(app, "\"z\": 26")).toBeNull(); // below the fold
    expect(rowContaining(app, "COMPOSER")).not.toBeNull(); // the composer kept its room
    const top = frameText(app, HEIGHT).split("\n").findIndex(line => line.includes("1  {"));
    // One line per wheel notch: "z" (line 27) arrives after a bounded number of notches.
    const notches = await wheelUntil(app, top, "\"z\": 26");
    expect(notches).toBeGreaterThan(0);
    expect(notches).toBeLessThan(30);
    expect(rowContaining(app, "\"a\": 1")).toBeNull(); // scrolled off the top
    close();
  });

  test("a body that is not JSON renders its raw lines", async () => {
    const { app, close } = await sendBody("line one\nline two", { headers: { "content-type": "text/plain" } });
    expect(rowContaining(app, "1  line one")).not.toBeNull();
    expect(rowContaining(app, "2  line two")).not.toBeNull();
    close();
  });

  test("broken JSON falls back to its raw text instead of a half layout", async () => {
    const { app, close } = await sendBody(`{"a":1,,}`, { headers: { "content-type": "application/json" } });
    expect(rowContaining(app, "1  {\"a\":1,,}")).not.toBeNull();
    close();
  });

  test("redaction runs before formatting: an echoed secret stays redacted in the pretty body", async () => {
    const canary = "fmt-secret-7c1e";
    const server = serve(req =>
      Response.json({ youSent: req.headers.get("authorization") ?? "", n: 1 }),
    );
    const app = await setupApp({
      "echo.ts": moduleSource("GET", server.url("/"), { headers: { authorization: `Bearer ${canary}` } }),
    });
    await openFirstRequest(app);
    await focusComposer(app);
    app.mockInput.pressEnter();
    await app.flush();
    await app.shell.composer.settled();
    await app.renderOnce();
    const text = frameText(app, HEIGHT);
    expect(text).toContain("\"youSent\": \"[redacted]\"");
    expect(text).not.toContain(canary);
    server.close();
  });
});

describe("response header", () => {
  test("status, latency and size share the RESPONSE row, like the mockup", async () => {
    const { app, close } = await sendBody("{}", { status: 201 });
    const row = rowContaining(app, "RESPONSE");
    expect(row).toMatch(/RESPONSE─+ 201 CREATED │ \d+ ms │ 2 B │ #1 · \d\d:\d\d:\d\d ─╮/);
    close();
  });

  test("the status is colored by class: success sage, errors love", async () => {
    const ok = await sendBody("{}", { status: 200 });
    expect(colorOf(ok.app, "200 OK")?.equals(RGBA.fromHex(THEME.color.sage))).toBe(true);
    ok.close();
    const failed = await sendBody("{}", { status: 503 });
    expect(colorOf(failed.app, "503 SERVICE UNAVAILABLE")?.equals(RGBA.fromHex(THEME.color.love))).toBe(true);
    failed.close();
  });
});
