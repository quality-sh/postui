import { afterAll, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import {
  focusComposer,
  focusResponse,
  HEIGHT,
  moduleSource,
  openFirstRequest,
  serve,
  setupApp,
  teardownApps,
} from "./helpers/tui-app.ts";
import type { AppSetup } from "./helpers/tui-app.ts";
import { MAX_BODY_WINDOW, startResponsePane, TUI_BODY_WINDOW } from "../src/tui/response-pane.ts";
import { frameText } from "./helpers/tui-capture.ts";


afterAll(async () => {
  delete process.env.POSTUI_TEST_TOKEN;
  await teardownApps();
});

/** Open the first request, send it, settle. */
async function sendFromApp(app: AppSetup): Promise<void> {
  await openFirstRequest(app);
  await focusComposer(app);
  app.mockInput.pressEnter();
  await app.flush();
  await app.shell.composer.settled();
  await app.renderOnce();
}

describe("response body window", () => {
  test("a person sees a real-size body whole: the TUI window is 64 KiB, not the agent digest", async () => {
    // Agents keep the 256 B digest (rule_agent_body_cap); the TUI is for people.
    const body = JSON.stringify({ items: Array.from({ length: 60 }, (_, i) => ({ id: i, name: `item-${i}` })) });
    expect(body.length).toBeGreaterThan(1024);
    const server = serve(() => new Response(body, { status: 200 }));
    const app = await setupApp({ "list.ts": moduleSource("GET", server.url("/")) });
    await sendFromApp(app);
    const text = frameText(app, HEIGHT);
    expect(text).toContain(`${body.length} bytes (complete)`);
    expect(text).not.toContain("showing first");
    expect(app.shell.response.bodyWindow).toBe(TUI_BODY_WINDOW);
    server.close();
  });

  test("+ widens the body window by re-sending through the pipeline", async () => {
    const tail = "tail-marker-4f21";
    // The padding is whitespace between JSON tokens: it pushes the tail past
    // the default window, and the pretty layout drops it, so the widened
    // body fits the pane without scrolling.
    const big = `{${" ".repeat(TUI_BODY_WINDOW + 400)}"tail":"${tail}"}`;
    let hits = 0;
    const server = serve(() => {
      hits += 1;
      return new Response(big, { status: 200 });
    });
    const app = await setupApp({ "wide.ts": moduleSource("GET", server.url("/")) });
    await sendFromApp(app);
    const first = frameText(app, HEIGHT);
    expect(first).toContain(`showing first ${TUI_BODY_WINDOW} of`); // bounded by the TUI window
    expect(first).not.toContain(tail); // past the window
    await focusResponse(app);
    app.mockInput.pressKey("+"); // 64 KiB → 128 KiB
    await app.flush();
    await app.shell.composer.settled();
    await app.renderOnce();
    const wider = frameText(app, HEIGHT);
    expect(hits).toBe(2); // widening re-sends: the CLI's --body-bytes semantics
    expect(wider).toContain("(complete)");
    for (const _ of Array.from({ length: 10 })) app.mockInput.pressArrow("down");
    await app.flush();
    await app.renderOnce();
    expect(frameText(app, HEIGHT)).toContain(tail); // now within the window (scrolled to)
    server.close();
  });

  test("- narrows the window; + steps it back up", async () => {
    const big = JSON.stringify({ pad: "y".repeat(100_000) });
    const server = serve(() => new Response(big, { status: 200 }));
    const app = await setupApp({ "cap.ts": moduleSource("GET", server.url("/")) });
    await sendFromApp(app);
    await focusResponse(app);
    expect(frameText(app, HEIGHT)).toContain(`first ${TUI_BODY_WINDOW} of`);
    app.mockInput.pressKey("-");
    await app.flush();
    await app.shell.composer.settled();
    await app.renderOnce();
    expect(frameText(app, HEIGHT)).toContain(`first ${TUI_BODY_WINDOW / 2} of`);
    app.mockInput.pressKey("+");
    await app.flush();
    await app.shell.composer.settled();
    await app.renderOnce();
    expect(frameText(app, HEIGHT)).toContain(`first ${TUI_BODY_WINDOW} of`);
    server.close();
  });

  test("the 1 MiB cap: + at the cap consumes the key but stops widening", async () => {
    // Pane-level, no shell, no sends: the spy accepts every window change, so
    // mashing + must top out at MAX_BODY_WINDOW and never exceed it.
    const setup = await createTestRenderer({ width: 80, height: 12 });
    let accepted: number | null = null;
    const pane = startResponsePane(setup.renderer, {
      testsDir: "/nonexistent",
      onWindowChange: (window) => {
        accepted = window;
        return true;
      },
    });
    setup.renderer.root.add(pane.pane);
    pane.handleKey({ name: "+", ctrl: false }); // no result yet: inert
    expect(accepted).toBeNull();
    pane.showResult(
      {
        outcome: {
          kind: "sent",
          status: 200,
          request: { method: "GET", url: "u", headers: [], headersOmitted: 0 },
          response: {
            status: 200,
            headers: [],
            headersOmitted: 0,
            size: 1,
            shape: "opaque",
            excerpt: "x",
            excerptBytes: 1,
            truncated: false,
          },
          redirectedTo: null,
        },
        secrets: [],
      },
      1,
    );
    for (let i = 0; i < 40; i += 1) pane.handleKey({ name: "+", ctrl: false });
    expect(pane.bodyWindow).toBe(MAX_BODY_WINDOW);
    expect(accepted as number | null).toBe(MAX_BODY_WINDOW);
    setup.renderer.destroy();
  });

  test("a + during an in-flight re-send is refused and the window stays put", async () => {
    let hits = 0;
    const big = JSON.stringify({ pad: "p".repeat(TUI_BODY_WINDOW * 3) }); // truncated at 64 and 128 KiB
    const server = serve(async () => {
      hits += 1;
      await Bun.sleep(60);
      return new Response(big, { status: 200 });
    });
    const app = await setupApp({ "slow.ts": moduleSource("GET", server.url("/")) });
    await sendFromApp(app);
    await focusResponse(app);
    app.mockInput.pressKey("+"); // starts the 64 → 128 KiB re-send
    await app.flush();
    app.mockInput.pressKey("+"); // refused: a send is in flight
    await app.flush();
    await app.shell.composer.settled();
    await app.renderOnce();
    const text = frameText(app, HEIGHT);
    expect(text).toContain("window 128.0 KB"); // exactly one widen landed
    expect(hits).toBe(2); // initial send + one widen, nothing extra
    server.close();
  });
});
