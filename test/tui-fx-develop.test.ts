import { afterEach, describe, expect, test } from "bun:test";
import { BoxRenderable, StyledText, TextRenderable, fg } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { instantClock, manualClock } from "../src/tui/fx/clock.ts";
import { cellsFromSpans, developFrame, developLines, type Cell } from "../src/tui/fx/develop.ts";
import { BLOOM, FX } from "../src/tui/fx/palette.ts";

const KEY = "#e0def4";
const STR = "#f6c177";
const PUNCT = "#6e6a86";

/** A small highlighted JSON body as cells. */
function body(): Cell[][] {
  const spans: [string, string][][] = [
    [["{", PUNCT]],
    [["  ", KEY], ['"id"', KEY], [": ", PUNCT], ["42", "#9ccfd8"], [",", PUNCT]],
    [["  ", KEY], ['"name"', KEY], [": ", PUNCT], ['"Ada Lovelace"', STR], [",", PUNCT]],
    [["  ", KEY], ['"note"', KEY], [": ", PUNCT], ['"café ✓ → ok"', STR]],
    [["}", PUNCT]],
  ];
  return spans.map(line => line.flatMap(([text, color]) => Array.from(text, char => ({ char, fg: color }))));
}

const same = (a: Cell, b: Cell): boolean => a.char === b.char && a.fg === b.fg;

describe("developFrame", () => {
  test("t=0 is all fog dots with spaces kept", () => {
    const lines = body();
    const frame = developFrame(lines, 0, 3);
    for (const [row, line] of frame.entries()) {
      for (const [col, cell] of line.entries()) {
        const input = lines[row]?.[col];
        if (input?.char === " ") {
          expect(cell).toEqual(input);
          continue;
        }
        expect(cell.char).toBe("·");
        expect(cell.fg).toBe(FX.fog);
      }
    }
  });

  test("t=1 is exactly the input", () => {
    const lines = body();
    expect(developFrame(lines, 1, 3)).toEqual(lines);
  });

  test("resolution is monotonic and passes through the bloom palette", () => {
    const lines = body();
    let resolved = -1;
    let bloomed = false;
    for (let step = 0; step <= 40; step += 1) {
      const frame = developFrame(lines, step / 40, 9);
      const count = frame.flat().filter((cell, i) => same(cell, lines.flat()[i] ?? cell)).length;
      expect(count).toBeGreaterThanOrEqual(resolved);
      resolved = count;
      if (frame.flat().some(cell => BLOOM.includes(cell.fg))) bloomed = true;
    }
    expect(bloomed).toBe(true);
  });

  test("top rows resolve before bottom rows", () => {
    const lines = Array.from({ length: 30 }, () => Array.from("abcdefghij", char => ({ char, fg: KEY })));
    const frame = developFrame(lines, 0.6, 1);
    const done = (row: number): number => (frame[row] ?? []).filter(cell => /[a-j]/.test(cell.char)).length;
    expect(done(0)).toBeGreaterThan(done(29));
  });

  test("cellsFromSpans splits graphemes and wraps by columns", () => {
    const cells = cellsFromSpans([[{ text: '"ab', fg: STR }, { text: "c👍🏽d", fg: KEY }], []], { wrap: 4 });
    expect(cells.map(line => line.map(cell => cell.char).join(""))).toEqual(['"abc', "👍🏽d", ""]);
    expect(cells[0]?.[3]).toEqual({ char: "c", fg: KEY });
  });

  test("same seed, same frame; another seed, another jitter", () => {
    const lines = body();
    expect(developFrame(lines, 0.5, 4)).toEqual(developFrame(lines, 0.5, 4));
    expect(developFrame(lines, 0.5, 4)).not.toEqual(developFrame(lines, 0.5, 5));
  });
});

const setups: TestRendererSetup[] = [];

async function screen(width = 40, height = 8): Promise<TestRendererSetup> {
  const setup = await createTestRenderer({ width, height });
  setups.push(setup);
  return setup;
}

afterEach(() => {
  for (const setup of setups) setup.renderer.destroy();
  setups.length = 0;
});

/** The captured frame as [text, fg hex, bg hex] triples per cell run. */
function spanKeys(setup: TestRendererSetup): string[] {
  return setup.captureSpans().lines.flatMap((line, row) =>
    line.spans.map(span => `${row}:${span.text}|${span.fg.toString()}|${span.bg.toString()}`),
  );
}

describe("developLines", () => {
  test("frames follow the manual clock and finish on time", async () => {
    const setup = await screen();
    const clock = manualClock();
    let done = 0;
    const dev = developLines(setup.renderer, body(), { durationMs: 300, clock, onDone: () => (done += 1) });
    setup.renderer.root.add(dev);
    await setup.renderOnce();
    expect(setup.captureCharFrame().split("\n")[2]?.trimEnd()).toBe("  ······· ···· ··········");
    clock.advance(150);
    await setup.renderOnce();
    const mid = setup.captureCharFrame();
    expect(mid).not.toContain("Ada Lovelace");
    expect(done).toBe(0);
    clock.advance(160);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain('"name": "Ada Lovelace",');
    expect(setup.captureCharFrame()).toContain('"note": "café ✓ → ok"');
    expect(done).toBe(1);
    expect(dev.done).toBe(true);
    expect(clock.pending()).toBe(0);
  });

  test("finish() lands the end state at once and fires onDone once", async () => {
    const setup = await screen();
    const clock = manualClock();
    let done = 0;
    const dev = developLines(setup.renderer, body(), { clock, onDone: () => (done += 1) });
    setup.renderer.root.add(dev);
    dev.finish();
    dev.finish();
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain('"id": 42,');
    expect(done).toBe(1);
    expect(clock.pending()).toBe(0);
  });

  test("settled output matches plain text cell for cell", async () => {
    const lines = body();
    const plain = await screen();
    const box = new BoxRenderable(plain.renderer, { flexDirection: "column", backgroundColor: FX.panel, width: "100%", height: "100%" });
    for (const line of lines) {
      box.add(new TextRenderable(plain.renderer, { content: new StyledText(line.map(cell => fg(cell.fg)(cell.char))) }));
    }
    plain.renderer.root.add(box);
    await plain.renderOnce();

    const developed = await screen();
    const host = new BoxRenderable(developed.renderer, { flexDirection: "column", backgroundColor: FX.panel, width: "100%", height: "100%" });
    const dev = developLines(developed.renderer, lines, { clock: manualClock() });
    host.add(dev);
    developed.renderer.root.add(host);
    dev.finish();
    await developed.renderOnce();
    expect(spanKeys(developed)).toEqual(spanKeys(plain));
  });

  test("destroy clears the ticker", async () => {
    const setup = await screen();
    const clock = manualClock();
    const dev = developLines(setup.renderer, body(), { clock });
    setup.renderer.root.add(dev);
    expect(clock.pending()).toBe(1);
    dev.destroyRecursively();
    expect(clock.pending()).toBe(0);
  });

  test("the instant clock settles at once and calls onDone on a microtask", async () => {
    const setup = await screen();
    let done = false;
    const dev = developLines(setup.renderer, body(), { clock: instantClock(), onDone: () => (done = true) });
    setup.renderer.root.add(dev);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Ada Lovelace");
    expect(done).toBe(true);
  });

  test("200 × 120 develops within a frame budget", async () => {
    const setup = await screen(130, 60);
    const clock = manualClock();
    const line = (row: number): Cell[] =>
      Array.from({ length: 120 }, (_, col) => ({ char: String.fromCharCode(97 + ((row + col) % 26)), fg: BLOOM[col % 5] ?? KEY }));
    const dev = developLines(setup.renderer, Array.from({ length: 200 }, (_, row) => line(row)), { clock });
    setup.renderer.root.add(dev);
    await setup.renderOnce();
    // Sequential by design: each frame renders at the clock's next step.
    const frames = async (left: number): Promise<void> => {
      if (left === 0) return;
      clock.advance(16);
      await setup.renderOnce();
      await frames(left - 1);
    };
    const started = performance.now();
    await frames(18);
    const perFrame = (performance.now() - started) / 18;
    expect(perFrame).toBeLessThan(16);
    dev.finish();
  });
});
