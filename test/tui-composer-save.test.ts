import { afterAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { renderModule } from "../src/save/emitter.ts";
import {
  focusComposer,
  HEIGHT,
  moduleSource,
  openFirstRequest,
  setupApp,
  teardownApps,
} from "./helpers/tui-app.ts";
import { arrows, settle } from "./helpers/composer-input.ts";
import { frameText } from "./helpers/tui-capture.ts";

const CANARY = "save-secret-77e2";

afterAll(async () => {
  await teardownApps();
});

describe("composer save (ctrl+s)", () => {
  test("writes the draft to its own module in the `postui save` shape; ● clears, a note confirms", async () => {
    const app = await setupApp({
      "create-user.ts": moduleSource("GET", "https://api.dev/users", { headers: { accept: "*/*" } }),
    });
    await openFirstRequest(app);
    await focusComposer(app);
    await app.mockInput.typeText("/42");
    await arrows(app, "up", "right", "down", "down", "down"); // POST, then into BODY
    await app.mockInput.typeText('{"name":"Ada"}');
    await app.flush();
    expect(frameText(app, HEIGHT)).toContain("create-user.ts ●");
    app.mockInput.pressKey("s", { ctrl: true });
    await settle(app);
    const onDisk = await readFile(join(app.requestsDir, "create-user.ts"), "utf8");
    expect(onDisk).toBe(
      renderModule({
        method: "POST",
        url: new URL("https://api.dev/users/42"),
        headers: [["accept", "*/*"]],
        body: { kind: "raw", contentType: null, text: '{"name":"Ada"}' },
      }),
    );
    const text = frameText(app, HEIGHT);
    expect(text).not.toContain("create-user.ts ●");
    expect(text).toContain("saved create-user.ts");
    expect(app.shell.composer.edited).toBe(false);
    expect(app.shell.composer.field).toBe("content"); // save never moves focus
  });

  test("a literal credential is refused with a note and the module is left alone", async () => {
    const original = moduleSource("GET", "https://api.dev/one");
    const app = await setupApp({ "one.ts": original });
    await openFirstRequest(app);
    await focusComposer(app);
    await arrows(app, "down", "right", "down"); // AUTH add row
    await app.mockInput.typeText(`Bearer ${CANARY}`);
    app.mockInput.pressKey("s", { ctrl: true });
    await settle(app);
    expect(await readFile(join(app.requestsDir, "one.ts"), "utf8")).toBe(original);
    const text = frameText(app, HEIGHT);
    expect(text).toContain("not saved: Authorization holds a literal credential");
    expect(text).toContain("one.ts ●"); // still dirty
    expect(text).not.toContain(CANARY);
  });

  test("an env-referenced credential saves as the reference", async () => {
    const app = await setupApp({ "one.ts": moduleSource("GET", "https://api.dev/one") });
    await openFirstRequest(app);
    await focusComposer(app);
    await arrows(app, "down", "right", "down");
    await app.mockInput.typeText("Bearer $API_TOKEN");
    app.mockInput.pressKey("s", { ctrl: true });
    await settle(app);
    const onDisk = await readFile(join(app.requestsDir, "one.ts"), "utf8");
    expect(onDisk).toContain('"Authorization": "Bearer $API_TOKEN"');
    expect(frameText(app, HEIGHT)).toContain("saved one.ts");
  });

  test("a saved draft survives the collections refresh: the reload matches, nothing resets", async () => {
    const app = await setupApp({ "one.ts": moduleSource("GET", "https://api.dev/one") });
    await openFirstRequest(app);
    await focusComposer(app);
    await app.mockInput.typeText("/two");
    app.mockInput.pressKey("s", { ctrl: true });
    await settle(app);
    app.mockInput.pressTab();
    app.mockInput.pressTab(); // → response → collections (refresh-on-focus)
    await app.flush();
    await app.shell.collections.settled();
    await app.renderOnce();
    expect(frameText(app, HEIGHT)).toContain("https://api.dev/one/two");
    expect(app.shell.composer.edited).toBe(false);
    expect(app.shell.composer.field).toBe("url");
  });
});
