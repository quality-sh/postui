import { afterAll, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { startResponsePane } from "../src/tui/response-pane.ts";
import { COLLECTIONS_PANE_ID } from "../src/tui/shell.ts";
import { frameText, rowContaining } from "./helpers/tui-capture.ts";
import {
  enterFromCollections,
  focusComposer,
  focusResponse,
  HEIGHT,
  moduleSource,
  serve,
  setupApp,
  teardownApps,
} from "./helpers/tui-app.ts";
import type { AppSetup } from "./helpers/tui-app.ts";

/**
 * Keyboard navigation: arrows are the advertised keys (j/k/h/l stay silent
 * aliases), enter in collections opens-and-sends in one step, and the
 * response pane scrolls under its fixed status line and tabs.
 */

afterAll(async () => {
  await teardownApps();
});

/** A stub server that records each request's path. */
function pathServer(): ReturnType<typeof serve> & { hits: string[] } {
  const hits: string[] = [];
  const server = serve(req => {
    const path = new URL(req.url).pathname;
    hits.push(path);
    return Response.json({ path });
  });
  return { ...server, hits };
}

/** Send the first request from the tree, then move focus to the response pane. */
async function sendAndFocusResponse(app: AppSetup): Promise<void> {
  await enterFromCollections(app);
  await focusComposer(app);
  await focusResponse(app);
}

describe("collections arrows", () => {
  test("arrows move the highlight like j/k", async () => {
    const setup = await setupApp({
      "one.ts": moduleSource("POST", "https://api.dev/users"),
      "two.ts": moduleSource("GET", "https://api.dev/users"),
    });
    setup.mockInput.pressArrow("down");
    await setup.flush();
    expect(rowContaining(setup, "▶")).toContain("two");
    setup.mockInput.pressArrow("up");
    await setup.flush();
    expect(rowContaining(setup, "▶")).toContain("one");
  });
});

describe("enter sends from collections in one step", () => {
  test("enter opens the highlighted request and sends it; focus stays in collections", async () => {
    const server = pathServer();
    const app = await setupApp({
      "alpha-check.ts": moduleSource("GET", server.url("/alpha")),
    });
    await enterFromCollections(app);
    expect(app.shell.composer.loadedName).toBe("alpha-check");
    expect(server.hits).toEqual(["/alpha"]);
    expect(rowContaining(app, "200 OK")).not.toBeNull();
    expect(rowContaining(app, '"path": "/alpha"')).not.toBeNull();
    expect(app.shell.focus.focused).toBe(COLLECTIONS_PANE_ID);
    server.close();
  });

  test("down + enter sends the next request, again without leaving the tree", async () => {
    const server = pathServer();
    const app = await setupApp({
      "alpha-check.ts": moduleSource("GET", server.url("/alpha")),
      "beta-check.ts": moduleSource("GET", server.url("/beta")),
    });
    await enterFromCollections(app);
    app.mockInput.pressArrow("down");
    await app.flush();
    await enterFromCollections(app);
    expect(server.hits).toEqual(["/alpha", "/beta"]);
    expect(app.shell.composer.loadedName).toBe("beta-check");
    expect(rowContaining(app, '"path": "/beta"')).not.toBeNull();
    expect(app.shell.focus.focused).toBe(COLLECTIONS_PANE_ID);
    server.close();
  });

  test("enter on the already-open request sends the current draft without reloading it", async () => {
    const server = pathServer();
    const app = await setupApp({
      "alpha-check.ts": moduleSource("GET", server.url("/alpha")),
    });
    const { composer } = app.shell;
    const load = composer.load.bind(composer);
    let loads = 0;
    composer.load = request => {
      loads += 1;
      load(request);
    };
    await enterFromCollections(app);
    await enterFromCollections(app);
    expect(loads).toBe(1); // a reload would reset an edited draft
    expect(server.hits).toEqual(["/alpha", "/alpha"]);
    server.close();
  });
});

describe("response pane arrows", () => {
  test("↑/↓ scroll the body under a fixed status line and tabs; j/k are silent aliases", async () => {
    // 64 numbered lines in the default 256-byte window: far taller than the pane.
    const lines = Array.from({ length: 80 }, (_, i) => `l${String(i + 1).padStart(2, "0")}`);
    const server = serve(() => new Response(lines.join("\n"), { status: 200 }));
    const app = await setupApp({ "long.ts": moduleSource("GET", server.url("/")) });
    await sendAndFocusResponse(app);
    expect(frameText(app, HEIGHT)).toContain(" 1 │ l01");
    for (const _ of [1, 2, 3, 4, 5]) app.mockInput.pressArrow("down");
    await app.flush();
    await app.renderOnce();
    expect(app.shell.response.scrollTop).toBe(5);
    let text = frameText(app, HEIGHT);
    expect(text).not.toContain(" 1 │ l01"); // scrolled out…
    expect(text).toContain("200 OK"); // …under the status line…
    expect(text).toContain("BODY  HEADERS  TESTS"); // …and the tabs, which stay
    app.mockInput.pressKey("k");
    await app.flush();
    expect(app.shell.response.scrollTop).toBe(4);
    app.mockInput.pressKey("j");
    await app.flush();
    expect(app.shell.response.scrollTop).toBe(5);
    for (const _ of Array.from({ length: 10 })) app.mockInput.pressArrow("up");
    await app.flush();
    await app.renderOnce();
    expect(app.shell.response.scrollTop).toBe(0); // clamped at the top
    text = frameText(app, HEIGHT);
    expect(text).toContain(" 1 │ l01");
    server.close();
  });

  test("←/→ switch BODY/HEADERS/TESTS, wrapping; a tab switch starts at the top", async () => {
    const lines = Array.from({ length: 80 }, (_, i) => `l${i}`);
    const server = serve(() => new Response(lines.join("\n"), { status: 200 }));
    const app = await setupApp({ "tabs.ts": moduleSource("GET", server.url("/")) });
    await sendAndFocusResponse(app);
    app.mockInput.pressArrow("down");
    await app.flush();
    expect(app.shell.response.scrollTop).toBe(1);
    app.mockInput.pressArrow("right"); // BODY → HEADERS
    await app.flush();
    await app.renderOnce();
    expect(frameText(app, HEIGHT)).toContain("content-type: text/plain");
    expect(app.shell.response.scrollTop).toBe(0);
    app.mockInput.pressArrow("left"); // back to BODY
    await app.flush();
    await app.renderOnce();
    expect(frameText(app, HEIGHT)).toContain("│ l0");
    app.mockInput.pressArrow("left"); // wraps to TESTS
    await app.flush();
    await app.shell.response.settled();
    await app.renderOnce();
    expect(frameText(app, HEIGHT)).toContain("no generated tests for tabs");
    server.close();
  });

  test("↑/↓ with no result to scroll fall through (nothing consumes them)", async () => {
    const setup = await createTestRenderer({ width: 80, height: 12 });
    const pane = startResponsePane(setup.renderer, {
      testsDir: "/nonexistent",
      onWindowChange: () => true,
    });
    expect(pane.handleKey({ name: "down", ctrl: false })).toBe(false);
    expect(pane.handleKey({ name: "up", ctrl: false })).toBe(false);
    expect(pane.scrollTop).toBe(0);
    setup.renderer.destroy();
  });
});
