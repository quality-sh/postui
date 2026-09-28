import { afterEach, describe, expect, test } from "bun:test";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { fxClock, instantClock, manualClock, realClock, setFxClock } from "../src/tui/fx/clock.ts";
import { FX } from "../src/tui/fx/palette.ts";
import { skeletonCell, skeletonLines } from "../src/tui/fx/skeleton.ts";
import { halftoneSpinner, spinnerFrame } from "../src/tui/fx/spinner.ts";
import { mountToasts } from "../src/tui/fx/toast.ts";

const setups: TestRendererSetup[] = [];

async function screen(width = 60, height = 16): Promise<TestRendererSetup> {
  const setup = await createTestRenderer({ width, height });
  setups.push(setup);
  return setup;
}

afterEach(() => {
  for (const setup of setups) setup.renderer.destroy();
  setups.length = 0;
});

const rows = (setup: TestRendererSetup): string[] => setup.captureCharFrame().split("\n");

describe("manualClock", () => {
  test("fires due timers in time order and cancels cleanly", () => {
    const clock = manualClock();
    const log: string[] = [];
    const stopTick = clock.every(10, () => log.push(`tick@${clock.now()}`));
    clock.after(25, () => log.push(`once@${clock.now()}`));
    clock.advance(30);
    expect(log).toEqual(["tick@10", "tick@20", "once@25", "tick@30"]);
    stopTick();
    expect(clock.pending()).toBe(0);
    clock.advance(100);
    expect(log).toHaveLength(4);
    expect(clock.now()).toBe(130);
  });

  test("the default clock can be swapped and restored", () => {
    const original = fxClock();
    const instant = instantClock();
    const restore = setFxClock(instant);
    expect(fxClock()).toBe(instant);
    restore();
    expect(fxClock()).toBe(original);
  });

  test("real timers are unref'd and cancellable", async () => {
    const clock = realClock();
    let fired = 0;
    const cancel = clock.every(5, () => (fired += 1));
    await Bun.sleep(30);
    cancel();
    const seen = fired;
    await Bun.sleep(20);
    expect(seen).toBeGreaterThan(0);
    expect(fired).toBe(seen);
  });
});

describe("halftoneSpinner", () => {
  test("the head swells and travels, then turns back", () => {
    const heads = Array.from({ length: 12 }, (_, frame) =>
      spinnerFrame(frame, 4).findIndex(cell => cell.char === "●"),
    );
    expect(heads).toEqual([0, -1, 1, -1, 2, -1, 3, -1, 2, -1, 1, -1]);
    const first = spinnerFrame(0, 4);
    expect(first.map(cell => cell.char).join("")).toBe("●•··");
    expect(first[0]?.fg).toBe(FX.accent);
    expect(first[3]?.fg).toBe(FX.fog);
    expect(spinnerFrame(0, 4, { glyphs: "braille" })[0]?.char).toBe("⣿");
  });

  test("draws the clock's frame beside text and stops on the static frame", async () => {
    const setup = await screen();
    const clock = manualClock();
    const row = new BoxRenderable(setup.renderer, { flexDirection: "row", gap: 1 });
    const spinner = halftoneSpinner(setup.renderer, { clock });
    row.add(spinner);
    row.add(new TextRenderable(setup.renderer, { content: "GET /users · 34ms" }));
    setup.renderer.root.add(row);
    await setup.renderOnce();
    expect(rows(setup)[0]?.trimEnd()).toBe("●•·· GET /users · 34ms");
    clock.advance(80 * 4);
    await setup.renderOnce();
    expect(rows(setup)[0]?.slice(0, 4)).toBe("·•●•");
    expect(spinner.frame).toBe(4);
    spinner.stop();
    expect(clock.pending()).toBe(0);
    await setup.renderOnce();
    expect(rows(setup)[0]?.slice(0, 4)).toBe("●•··");
  });

  test("destroy clears its timer", async () => {
    const setup = await screen();
    const clock = manualClock();
    const spinner = halftoneSpinner(setup.renderer, { clock, width: 5 });
    setup.renderer.root.add(spinner);
    expect(clock.pending()).toBe(1);
    spinner.destroyRecursively();
    expect(clock.pending()).toBe(0);
  });
});

describe("skeletonLines", () => {
  test("a stopped field is plain fog dots in line shapes", async () => {
    const setup = await screen(40, 6);
    const clock = manualClock();
    const skeleton = skeletonLines(setup.renderer, { lines: 3, width: 20, widths: [1, 0.5, 0.25], clock });
    setup.renderer.root.add(skeleton);
    skeleton.stop();
    await setup.renderOnce();
    const [a, b, c] = rows(setup).map(line => line.trimEnd());
    expect(a).toHaveLength(20);
    expect(b).toHaveLength(10);
    expect(c).toHaveLength(5);
    expect(a).toMatch(/^[·∙]+$/);
  });

  test("the band drifts across over time", async () => {
    const setup = await screen(40, 6);
    const clock = manualClock();
    const skeleton = skeletonLines(setup.renderer, { lines: 2, width: 30, clock });
    setup.renderer.root.add(skeleton);
    const bandAt = (): number => rows(setup)[0]?.indexOf("•") ?? -1;
    clock.advance(600);
    await setup.renderOnce();
    const early = bandAt();
    clock.advance(300);
    await setup.renderOnce();
    expect(early).toBeGreaterThanOrEqual(0);
    expect(bandAt()).toBeGreaterThan(early);
    skeleton.destroyRecursively();
    expect(clock.pending()).toBe(0);
  });

  test("band levels are pure in (row, col, band)", () => {
    expect(skeletonCell(0, 10, 10).level).toBe(2);
    expect(skeletonCell(0, 10, null).level).toBe(0);
    expect(skeletonCell(2, 5, 5)).toEqual(skeletonCell(2, 5, 5));
  });
});

describe("mountToasts", () => {
  test("develops in top-right, stacks three, and hides after 1.8 s", async () => {
    const setup = await screen(70, 20);
    const clock = manualClock();
    const toasts = mountToasts(setup.renderer, setup.renderer.root, { clock });
    toasts.show("saved users.ts", "success");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain("saved users.ts");
    clock.advance(200);
    await setup.renderOnce();
    const line = rows(setup).find(row => row.includes("saved users.ts")) ?? "";
    expect(line).toContain("▌ ✓ saved users.ts");
    expect(line.trimEnd().length).toBeGreaterThan(60);

    clock.advance(500);
    toasts.show("imported ping", "info");
    toasts.show("refused: file exists", "error");
    toasts.show("saved again.ts", "success");
    expect(toasts.count).toBe(3);
    clock.advance(200);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("saved users.ts");
    expect(frame.indexOf("saved again.ts")).toBeLessThan(frame.indexOf("imported ping"));

    clock.advance(1800);
    await setup.renderOnce();
    expect(toasts.count).toBe(0);
    expect(setup.captureCharFrame()).not.toContain("▌");
    expect(clock.pending()).toBe(0);
    toasts.destroy();
  });

  test("destroy drops live toasts and their timers", async () => {
    const setup = await screen();
    const clock = manualClock();
    const toasts = mountToasts(setup.renderer, setup.renderer.root, { clock });
    toasts.show("one", "info");
    toasts.show("two", "error");
    expect(clock.pending()).toBeGreaterThan(0);
    toasts.destroy();
    expect(toasts.count).toBe(0);
    expect(clock.pending()).toBe(0);
  });
});
