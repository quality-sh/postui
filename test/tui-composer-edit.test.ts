import { afterAll, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  focusComposer,
  HEIGHT,
  moduleSource,
  openFirstRequest,
  serve,
  setupApp,
  teardownApps,
} from "./helpers/tui-app.ts";
import { arrows, pressCtrl, pressEscape, settle } from "./helpers/composer-input.ts";
import { frameText } from "./helpers/tui-capture.ts";

afterAll(async () => {
  await teardownApps();
});

describe("composer editing", () => {
  test("the URL types at a visible cursor: ←, home, delete; the send uses the draft", async () => {
    let hitPath = "";
    const server = serve(req => {
      hitPath = new URL(req.url).pathname;
      return new Response("{}", { status: 200 });
    });
    const app = await setupApp({
      "one.ts": moduleSource("GET", server.url("/one")),
    });
    await openFirstRequest(app);
    await focusComposer(app);
    expect(app.shell.composer.field).toBe("url"); // lands on the URL: type straight away
    await app.mockInput.typeText("x"); // cursor starts at the end
    await arrows(app, "left", "left");
    await app.mockInput.typeText("-"); // "/on-ex"
    await app.flush();
    app.mockInput.pressKey("HOME");
    await app.flush();
    app.mockInput.pressKey("DELETE"); // drops the "h" of http
    await app.flush();
    expect(frameText(app, HEIGHT)).toContain(`│ ${server.url("/on-ex").slice(1)}`);
    await app.mockInput.typeText("h"); // back in at the start
    app.mockInput.pressKey("END");
    await arrows(app, "left", "left", "left"); // before the "-"
    app.mockInput.pressKey("DELETE");
    await app.flush();
    expect(frameText(app, HEIGHT)).toContain(server.url("/onex"));
    app.mockInput.pressEnter(); // enter sends straight from the URL
    await settle(app);
    expect(hitPath).toBe("/onex"); // the draft, not the module, was sent
    const onDisk = await readFile(join(app.requestsDir, "one.ts"), "utf8");
    expect(onDisk).toContain(`"${server.url("/one")}"`); // no write-back without ctrl+s
    expect(frameText(app, HEIGHT)).toContain("COMPOSER · one.ts ●"); // dirty marker
    server.close();
  });

  test("esc leaves the URL for the tab strip and keeps what was typed", async () => {
    const app = await setupApp({
      "one.ts": moduleSource("GET", "https://api.dev/one"),
    });
    await openFirstRequest(app);
    await focusComposer(app);
    await app.mockInput.typeText("/two");
    await app.flush();
    await pressEscape(app);
    expect(app.shell.composer.field).toBe("tabs");
    expect(app.shell.composer.isEditingText()).toBe(false);
    expect(frameText(app, HEIGHT)).toContain("https://api.dev/one/two");
  });

  test("←/→ and space cycle the method; the sent method is the one shown", async () => {
    let method = "";
    const server = serve(req => {
      method = req.method;
      return new Response("{}", { status: 200 });
    });
    const app = await setupApp({
      "one.ts": moduleSource("GET", server.url("/")),
    });
    await openFirstRequest(app);
    await focusComposer(app);
    await arrows(app, "up"); // URL → METHOD
    expect(app.shell.composer.field).toBe("method");
    await arrows(app, "right"); // GET → POST
    expect(frameText(app, HEIGHT)).toContain("POST ▾");
    app.mockInput.pressKey(" "); // space: POST → PUT
    await app.flush();
    await arrows(app, "right", "left"); // PATCH, back to PUT
    expect(frameText(app, HEIGHT)).toContain("PUT ▾");
    await arrows(app, "left", "left", "left"); // POST, GET, wraps to OPTIONS
    expect(frameText(app, HEIGHT)).toContain("OPTIONS ▾");
    await arrows(app, "right", "right"); // GET, POST
    app.mockInput.pressEnter();
    await settle(app);
    expect(method).toBe("POST");
    server.close();
  });

  test("the body edits directly: enter breaks the line, esc then enter sends", async () => {
    let received = "";
    const server = serve(async req => {
      received = await req.text();
      return new Response("{}", { status: 200 });
    });
    const app = await setupApp({
      "note.ts": moduleSource("POST", server.url("/"), { body: '{"a":1}' }),
    });
    await openFirstRequest(app);
    await focusComposer(app);
    await arrows(app, "down", "down"); // URL → tab strip → BODY content
    expect(app.shell.composer.field).toBe("content");
    app.mockInput.pressKey("END");
    await arrows(app, "left"); // before the closing brace
    await app.mockInput.typeText(',"b":2');
    app.mockInput.pressEnter(); // a newline, not a send
    await app.mockInput.typeText("q"); // q types in the body
    await app.flush();
    const text = frameText(app, HEIGHT);
    expect(text).toContain('1 │ {"a":1,"b":2');
    expect(text).toContain("2 │ q}"); // line numbers kept
    expect(received).toBe(""); // nothing sent yet
    await pressEscape(app);
    app.mockInput.pressEnter(); // from the tab strip, enter sends
    await settle(app);
    expect(received).toBe('{"a":1,"b":2\nq}');
    server.close();
  });

  test("ctrl+enter sends from inside the body when the terminal reports it", async () => {
    let hits = 0;
    const server = serve(() => {
      hits += 1;
      return new Response("{}", { status: 200 });
    });
    const app = await setupApp({
      "note.ts": moduleSource("POST", server.url("/"), { body: "x" }),
    });
    await openFirstRequest(app);
    await focusComposer(app);
    await arrows(app, "down", "down");
    await pressCtrl(app, "return");
    await settle(app);
    expect(hits).toBe(1);
    expect(app.shell.composer.field).toBe("content"); // still in the body
    server.close();
  });

  test("a long body scrolls to keep the cursor line in view", async () => {
    const body = Array.from({ length: 40 }, (_, i) => `line${i + 1}`).join("\n");
    const app = await setupApp({
      "long.ts": moduleSource("POST", "https://api.dev/long", { body }),
    });
    await openFirstRequest(app);
    await focusComposer(app);
    await arrows(app, "down", "down");
    expect(frameText(app, HEIGHT)).toContain(" 1 │ line1");
    await arrows(app, ...Array.from({ length: 30 }, () => "down" as const));
    const text = frameText(app, HEIGHT);
    expect(text).toContain("31 │ line31");
    expect(text).not.toMatch(/ 1 │ line1 /); // scrolled off the top
  });

  test("typing into an empty body starts one; emptying it again means no body", async () => {
    const app = await setupApp({
      "get.ts": moduleSource("GET", "https://api.dev/one"),
    });
    await openFirstRequest(app);
    await focusComposer(app);
    await arrows(app, "down", "down");
    await app.mockInput.typeText("hi");
    await app.flush();
    expect(frameText(app, HEIGHT)).toContain("1 │ hi");
    expect(app.shell.composer.edited).toBe(true);
    app.mockInput.pressBackspace();
    app.mockInput.pressBackspace();
    await app.flush();
    expect(app.shell.composer.edited).toBe(false); // back to body: null, as on disk
  });

  test("form bodies are display-only: entering them explains instead of failing silently", async () => {
    const app = await setupApp({
      "form.ts": moduleSource("POST", "https://api.dev/form", {
        body: [{ name: "user", value: "ada" }],
      }),
    });
    await openFirstRequest(app);
    await focusComposer(app);
    await arrows(app, "down", "down");
    const text = frameText(app, HEIGHT);
    expect(text).toContain("edited in the saved module");
    expect(text).toContain("user = ada"); // the form body is still shown
    expect(app.shell.composer.field).toBe("tabs");
  });

  test("hand-editing the module on disk reloads an unedited draft on refocus", async () => {
    const app = await setupApp({
      "watched.ts": moduleSource("GET", "https://api.dev/users"),
    });
    await openFirstRequest(app);
    await focusComposer(app);
    await writeFile(
      join(app.requestsDir, "watched.ts"),
      moduleSource("GET", "https://api.dev/health"),
    );
    // Real tab hops: composer → response → collections, whose refresh-on-focus
    // re-reads the module and hands it back to the unedited composer.
    app.mockInput.pressTab();
    await app.flush();
    app.mockInput.pressTab();
    await app.flush();
    await app.shell.collections.settled();
    await app.renderOnce();
    expect(frameText(app, HEIGHT)).toContain("https://api.dev/health");
  });

  test("an edited draft is never clobbered by a refresh", async () => {
    const app = await setupApp({
      "watched.ts": moduleSource("GET", "https://api.dev/users"),
    });
    await openFirstRequest(app);
    await focusComposer(app);
    await app.mockInput.typeText("x");
    await app.flush();
    await writeFile(
      join(app.requestsDir, "watched.ts"),
      moduleSource("GET", "https://api.dev/health"),
    );
    app.mockInput.pressTab();
    await app.flush();
    app.mockInput.pressTab();
    await app.flush();
    await app.shell.collections.settled();
    await app.renderOnce();
    // the draft (with the edit) won
    expect(frameText(app, HEIGHT)).toContain("https://api.dev/usersx");
    expect(frameText(app, HEIGHT)).not.toContain("https://api.dev/health");
  });
});
