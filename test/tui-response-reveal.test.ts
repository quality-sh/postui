import { afterEach, describe, expect, test } from "bun:test";
import { BoxRenderable } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { codeBlock, developingCodeBlock } from "../src/tui/code-block.ts";
import { manualClock, setFxClock } from "../src/tui/fx/clock.ts";
import { elapsedCounter, elapsedLabel } from "../src/tui/fx/elapsed.ts";
import { highlightJson } from "../src/tui/json-highlight.ts";
import { clockTime, targetPath } from "../src/tui/response-header.ts";

const setups: TestRendererSetup[] = [];
let restoreClock: (() => void) | null = null;

afterEach(() => {
  for (const setup of setups) setup.renderer.destroy();
  setups.length = 0;
  restoreClock?.();
  restoreClock = null;
});

/** A pane-like box (width × height) holding one code block. */
async function blockScreen(
  width: number,
  height: number,
  build: (setup: TestRendererSetup) => BoxRenderable,
): Promise<TestRendererSetup> {
  const setup = await createTestRenderer({ width, height });
  setups.push(setup);
  const pane = new BoxRenderable(setup.renderer, { width: "100%", height: "100%", flexDirection: "column" });
  pane.add(build(setup));
  setup.renderer.root.add(pane);
  await setup.renderOnce();
  await setup.renderOnce();
  return setup;
}

describe("header readouts", () => {
  test("elapsed reads whole ms under 10 s, tenths of a second after", () => {
    expect(elapsedLabel(0)).toBe("0 ms");
    expect(elapsedLabel(184.7)).toBe("184 ms");
    expect(elapsedLabel(12_345)).toBe("12.3 s");
  });

  test("the elapsed counter ticks on the fx clock and freezes when stopped", async () => {
    const clock = manualClock();
    const setup = await createTestRenderer({ width: 20, height: 1 });
    setups.push(setup);
    const counter = elapsedCounter(setup.renderer, { clock });
    setup.renderer.root.add(counter);
    clock.advance(240);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("  240 ms");
    counter.stop();
    clock.advance(500);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("  240 ms");
    expect(clock.pending()).toBe(0);
  });

  test("a target shows as its path; a template URL keeps what follows the env ref", () => {
    expect(targetPath("http://127.0.0.1:8996/users/7?full=1")).toBe("/users/7?full=1");
    expect(targetPath("$BASE_URL/users")).toBe("/users");
    expect(targetPath("${API}/v1/ping")).toBe("/v1/ping");
    expect(targetPath(`https://x.io/${"a".repeat(60)}`)).toHaveLength(40);
  });

  test("the time stamp is local HH:MM:SS", () => {
    expect(clockTime(new Date(2026, 8, 28, 7, 4, 9))).toBe("07:04:09");
  });
});

describe("developing code block", () => {
  const long = JSON.stringify({ id: 7, note: "n".repeat(70), tags: ["a", "b"] });

  test("it settles on exactly the plain block, long lines wrapped beside the gutter", async () => {
    const layout = highlightJson(long);
    const plain = await blockScreen(40, 12, setup => codeBlock(setup.renderer, layout));
    const clock = manualClock();
    restoreClock = setFxClock(clock);
    const developing = await blockScreen(40, 12, setup =>
      developingCodeBlock(setup.renderer, layout, { width: 40, rows: 12, seed: 3 }),
    );
    clock.advance(100);
    await developing.renderOnce();
    const mid = developing.captureCharFrame();
    expect(mid).not.toBe(plain.captureCharFrame());
    clock.advance(1000);
    await developing.renderOnce();
    await developing.renderOnce();
    expect(developing.captureCharFrame()).toBe(plain.captureCharFrame());
    expect(clock.pending()).toBe(0);
  });

  test("a block taller than its room leaves the scroll bar its column", async () => {
    const tall = JSON.stringify(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, "v".repeat(30)])));
    const layout = highlightJson(tall);
    const plain = await blockScreen(40, 8, setup => codeBlock(setup.renderer, layout));
    const clock = manualClock();
    restoreClock = setFxClock(clock);
    const developing = await blockScreen(40, 8, setup =>
      developingCodeBlock(setup.renderer, layout, { width: 40, rows: 8, seed: 5 }),
    );
    clock.advance(1000);
    await developing.renderOnce();
    await developing.renderOnce();
    expect(developing.captureCharFrame()).toBe(plain.captureCharFrame());
  });

  test("the same body develops differently under a different seed", async () => {
    const layout = highlightJson(long);
    const clock = manualClock();
    restoreClock = setFxClock(clock);
    const one = await blockScreen(40, 12, setup => developingCodeBlock(setup.renderer, layout, { width: 40, rows: 12, seed: 1 }));
    const two = await blockScreen(40, 12, setup => developingCodeBlock(setup.renderer, layout, { width: 40, rows: 12, seed: 2 }));
    clock.advance(150);
    await one.renderOnce();
    await two.renderOnce();
    expect(one.captureCharFrame()).not.toBe(two.captureCharFrame());
  });
});
