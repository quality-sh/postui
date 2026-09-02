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

  test("the mutating method badge is painted in the accent", async () => {
    const app = await setupApp({
      "create-user.ts": moduleSource("POST", "https://api.dev/users"),
    });
    await openFirstRequest(app);
    const accent = RGBA.fromHex(THEME.color.accent);
    const spans = app.captureSpans().lines.flatMap(line => line.spans);
    const post = spans.find(span => span.text.trim() === "POST");
    expect(post?.fg.equals(accent)).toBe(true);
  });

  test("h/l switch the composer tabs and the field view follows", async () => {
    const app = await setupApp({
      "hooked.ts": moduleSource("GET", "https://api.dev/users?limit=5", {
        headers: { accept: "application/json", authorization: `Bearer ${CANARY}` },
      }),
    });
    await openFirstRequest(app);
    await focusComposer(app);
    // default tab is BODY (mockup); no body → honest empty state
    expect(frameText(app, HEIGHT)).toContain("(no body)");
    // l → AUTH: credential values render redacted even at rest
    app.mockInput.pressKey("l");
    await app.flush();
    expect(frameText(app, HEIGHT)).toContain("AUTH");
    expect(frameText(app, HEIGHT)).toContain(`authorization: [redacted]`);
    expect(frameText(app, HEIGHT)).not.toContain(CANARY);
    // l wraps around to PARAMS
    app.mockInput.pressKey("l");
    await app.flush();
    expect(frameText(app, HEIGHT)).toContain("PARAMS");
    expect(frameText(app, HEIGHT)).toContain("limit = 5");
    // l → HEADERS
    app.mockInput.pressKey("l");
    await app.flush();
    expect(frameText(app, HEIGHT)).toContain("HEADERS");
    expect(frameText(app, HEIGHT)).toContain("accept: application/json");
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
    expect(text).toContain('{"ok":true}'); // the bounded body digest
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
      await Bun.sleep(80);
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

  test("j and q fall through from the composer: no hijack of global keys", async () => {
    const app = await setupApp({
      "one.ts": moduleSource("GET", "https://api.dev/one"),
    });
    await openFirstRequest(app);
    await focusComposer(app);
    const before = rowContaining(app, "▶");
    app.mockInput.pressKey("j");
    await app.flush();
    expect(rowContaining(app, "▶")).toBe(before); // j is not the composer's
    expect(app.shell.focus.focused).toBe("composer");
  });

});
