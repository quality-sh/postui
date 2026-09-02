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
import { frameText } from "./helpers/tui-capture.ts";

afterAll(async () => {
  delete process.env.POSTUI_TEST_TOKEN;
  await teardownApps();
});

describe("composer editing", () => {
  test("url editing stays in memory: the send uses it, the module file is untouched", async () => {
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
    app.mockInput.pressKey("u"); // edit url
    await app.flush();
    expect(frameText(app, HEIGHT)).toContain("▌"); // caret marks the edit
    app.mockInput.typeText("x");
    await app.flush();
    app.mockInput.pressEnter(); // commit the edit
    await app.flush();
    expect(frameText(app, HEIGHT)).toContain(`${server.url("/onex")}`);
    app.mockInput.pressEnter(); // send
    await app.flush();
    await app.shell.composer.settled();
    await app.renderOnce();
    expect(hitPath).toBe("/onex"); // the draft, not the module, was sent
    const onDisk = await readFile(join(app.requestsDir, "one.ts"), "utf8");
    expect(onDisk).toContain(`"${server.url("/one")}"`); // no write-back, ever
    expect(frameText(app, HEIGHT)).toContain("edited"); // the title says so
    server.close();
  });

  test("escape cancels an edit and restores the field", async () => {
    const app = await setupApp({
      "one.ts": moduleSource("GET", "https://api.dev/one"),
    });
    await openFirstRequest(app);
    await focusComposer(app);
    app.mockInput.pressKey("u");
    await app.flush();
    app.mockInput.typeText("junk");
    await app.flush();
    // The mock swallows a lone ESC byte (the parser buffers it for possible
    // escape sequences); emit the parsed event a real terminal delivers.
    app.renderer.keyInput.emit("keypress", { name: "escape", ctrl: false } as never);
    await app.flush();
    const text = frameText(app, HEIGHT);
    expect(text).toContain("https://api.dev/one");
    expect(text).not.toContain("junk");
  });

  test("body editing appends in memory and the edited body reaches the wire", async () => {
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
    app.mockInput.pressKey("b"); // edit body
    await app.flush();
    app.mockInput.typeText("}");
    await app.flush();
    app.mockInput.pressEnter(); // commit
    await app.flush();
    app.mockInput.pressEnter(); // send
    await app.flush();
    await app.shell.composer.settled();
    await app.renderOnce();
    expect(received).toBe('{"a":1}}'); // appended in memory, sent as typed
    server.close();
  });

  test("form bodies are display-only: b explains instead of failing silently", async () => {
    const app = await setupApp({
      "form.ts": moduleSource("POST", "https://api.dev/form", {
        body: [{ name: "user", value: "ada" }],
      }),
    });
    await openFirstRequest(app);
    await focusComposer(app);
    app.mockInput.pressKey("b");
    await app.flush();
    const text = frameText(app, HEIGHT);
    expect(text).toContain("edited in the saved module");
    expect(text).toContain("user = ada"); // the form body is still shown
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
    app.mockInput.pressKey("u");
    await app.flush();
    app.mockInput.typeText("x");
    await app.flush();
    app.mockInput.pressEnter();
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
