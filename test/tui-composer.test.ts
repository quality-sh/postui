import { afterAll, describe, expect, test } from "bun:test";
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
import { THEME } from "../src/tui/theme.ts";
import { frameText, rowContaining } from "./helpers/tui-capture.ts";

const CANARY = "agent-secret-91af";

afterAll(async () => {
  delete process.env.POSTUI_TEST_TOKEN;
  await teardownApps();
});

describe("composer pane", () => {
  test("renders the loaded request's fields: method, URL, tabs, body", async () => {
    const app = await setupApp({
      "create-user.ts": moduleSource("POST", "https://api.dev/users", {
        body: '{\n  "name": "Ada"\n}',
      }),
    });
    await openFirstRequest(app);
    const text = frameText(app, HEIGHT);
    expect(text).toContain("COMPOSER · create-user.ts");
    expect(text).toContain("POST");
    expect(text).toContain("https://api.dev/users");
    expect(text).toContain("SEND");
    expect(text).toContain("PARAMS");
    expect(text).toContain("HEADERS");
    expect(text).toContain("BODY");
    expect(text).toContain("AUTH");
    expect(text).toContain('"name": "Ada"'); // the body editor shows the body
  });

  test("the method pill paints the method in its own color", async () => {
    const app = await setupApp({
      "create-user.ts": moduleSource("POST", "https://api.dev/users"),
    });
    await openFirstRequest(app);
    const gold = RGBA.fromHex(THEME.color.gold);
    const spans = app.captureSpans().lines.flatMap(line => line.spans);
    // The composer's badge is the second POST on screen (collections first).
    const posts = spans.filter(span => span.text.trim() === "POST");
    expect(posts.length).toBe(2);
    for (const post of posts) expect(post.fg.equals(gold)).toBe(true);
  });

  test("←/→ on the tab strip switch the composer tabs and the content follows", async () => {
    const app = await setupApp({
      "hooked.ts": moduleSource("GET", "https://api.dev/users?limit=5", {
        headers: { accept: "application/json", authorization: `Bearer ${CANARY}` },
      }),
    });
    await openFirstRequest(app);
    await focusComposer(app);
    // default tab is BODY (mockup); no body → honest empty state
    expect(frameText(app, HEIGHT)).toContain("(no body)");
    app.mockInput.pressArrow("down"); // URL → tab strip
    await app.flush();
    expect(app.shell.composer.field).toBe("tabs");
    // → AUTH: credential values render redacted even at rest
    app.mockInput.pressArrow("right");
    await app.flush();
    expect(frameText(app, HEIGHT)).toContain("authorization: [redacted]");
    expect(frameText(app, HEIGHT)).toContain("literal — will not save");
    expect(frameText(app, HEIGHT)).not.toContain(CANARY);
    // → wraps around to PARAMS
    app.mockInput.pressArrow("right");
    await app.flush();
    expect(frameText(app, HEIGHT)).toContain("limit = 5");
    // → HEADERS: the credential stays redacted here too
    app.mockInput.pressArrow("right");
    await app.flush();
    expect(frameText(app, HEIGHT)).toContain("accept: application/json");
    expect(frameText(app, HEIGHT)).not.toContain(CANARY);
  });

  test("send success renders the bounded digest: status, latency, size, body", async () => {
    const server = serve(() => new Response(JSON.stringify({ ok: true }), { status: 201 }));
    const app = await setupApp({
      "create.ts": moduleSource("POST", server.url("/")),
    });
    await openFirstRequest(app);
    await focusComposer(app);
    app.mockInput.pressEnter(); // send
    await app.flush();
    await app.shell.composer.settled();
    await app.renderOnce();
    const text = frameText(app, HEIGHT);
    expect(text).toContain("201 CREATED"); // gold per theme for success codes
    expect(text).toMatch(/\d+ ms/); // latency
    expect(text).toContain("11 B"); // size (bytes)
    expect(text).toContain('"ok": true'); // the bounded body digest, pretty-printed
    expect(text).toContain("(complete)"); // within the default window
    server.close();
  });

  test("a non-2xx response renders the status in the accent and the named rejection", async () => {
    const server = serve(() => new Response("nope", { status: 404 }));
    const app = await setupApp({
      "missing.ts": moduleSource("GET", server.url("/")),
    });
    await openFirstRequest(app);
    await focusComposer(app);
    app.mockInput.pressEnter();
    await app.flush();
    await app.shell.composer.settled();
    await app.renderOnce();
    const text = frameText(app, HEIGHT);
    expect(text).toContain("404 NOT FOUND");
    expect(text).toContain("SendRejectedError"); // named, on the diagnostics region
    server.close();
  });

  test("a send with an unset token fails with the named error and zero network I/O", async () => {
    let hits = 0;
    const server = serve(() => {
      hits += 1;
      return new Response("{}", { status: 200 });
    });
    const app = await setupApp({
      "tokened.ts": moduleSource("GET", server.url("/"), {
        headers: { authorization: "Bearer $POSTUI_TEST_TOKEN" },
      }),
    });
    delete process.env.POSTUI_TEST_TOKEN; // the critical absence
    await openFirstRequest(app);
    await focusComposer(app);
    app.mockInput.pressEnter();
    await app.flush();
    await app.shell.composer.settled();
    await app.renderOnce();
    const text = frameText(app, HEIGHT);
    expect(text).toContain("MissingEnvError"); // named typed error, not a crash
    expect(text).toContain("POSTUI_TEST_TOKEN"); // names, never values
    expect(hits).toBe(0); // the send never touched the network
    // The TUI is alive: a later send with the token set works.
    process.env.POSTUI_TEST_TOKEN = CANARY;
    app.mockInput.pressEnter();
    await app.flush();
    await app.shell.composer.settled();
    await app.renderOnce();
    expect(frameText(app, HEIGHT)).toContain("200 OK");
    expect(hits).toBe(1);
    server.close();
  });

  test("a send while another send is in flight is refused with a note, never queued", async () => {
    let hits = 0;
    const server = serve(async () => {
      hits += 1;
      await Bun.sleep(400);
      return new Response("{}", { status: 200 });
    });
    const app = await setupApp({
      "slow.ts": moduleSource("GET", server.url("/")),
    });
    await openFirstRequest(app);
    await focusComposer(app);
    app.mockInput.pressEnter(); // first send starts
    await app.flush();
    app.mockInput.pressEnter(); // second send while in flight
    await app.flush();
    const midFlight = frameText(app, HEIGHT);
    expect(midFlight).toContain("already in flight");
    await app.shell.composer.settled();
    await app.renderOnce();
    expect(hits).toBe(1); // no duplicate (mutating) request was queued
    server.close();
  });

  test("the focused URL consumes every printable key: j, q and / type, never navigate, quit or search", async () => {
    const app = await setupApp({
      "one.ts": moduleSource("GET", "https://api.dev/one"),
    });
    await openFirstRequest(app);
    await focusComposer(app);
    let quit = false;
    void app.shell.onQuit.then(() => {
      quit = true;
      return quit;
    });
    const before = rowContaining(app, "▌");
    await app.mockInput.typeText("jq/");
    await app.flush();
    expect(app.shell.composer.isEditingText()).toBe(true);
    expect(frameText(app, HEIGHT)).toContain("https://api.dev/onejq/");
    expect(rowContaining(app, "▌")).toBe(before);
    expect(app.shell.focus.focused).toBe("composer");
    expect(app.shell.searching).toBe(false);
    expect(quit).toBe(false);
  });

  test("off the text fields q falls through to the global map and quits", async () => {
    const app = await setupApp({
      "one.ts": moduleSource("GET", "https://api.dev/one"),
    });
    await openFirstRequest(app);
    await focusComposer(app);
    let quit = false;
    void app.shell.onQuit.then(() => {
      quit = true;
      return quit;
    });
    app.mockInput.pressArrow("down"); // the tab strip is not a text field
    await app.flush();
    expect(app.shell.composer.isEditingText()).toBe(false);
    app.mockInput.pressKey("q");
    await app.flush();
    expect(quit).toBe(true);
  });

  test("one frame: the tab content has no box of its own and no in-pane hint line", async () => {
    const app = await setupApp({
      "note.ts": moduleSource("POST", "https://api.dev/notes", { body: "hello" }),
    });
    await openFirstRequest(app);
    const text = frameText(app, HEIGHT);
    expect(text).not.toContain("─BODY─"); // the old titled inner box
    // the gutter sits one cell in from the pane border: no nested border
    // between, and no rule between the gutter and the text
    expect(rowContaining(app, " 1  hello")).toMatch(/│ {2}1 {2}hello/);
    expect(text).not.toContain("u edit url");
  });
});
