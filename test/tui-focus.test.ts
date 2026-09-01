import { describe, expect, test } from "bun:test";
import { FocusRegistry, UnknownPaneError, DuplicatePaneError } from "../src/tui/focus.ts";

describe("FocusRegistry", () => {
  test("first registered pane becomes focused", () => {
    const focus = new FocusRegistry();
    focus.register("collections");
    expect(focus.focused).toBe("collections");
  });

  test("tab order is registration order", () => {
    const focus = new FocusRegistry();
    focus.register("collections");
    focus.register("composer");
    expect(focus.ids).toEqual(["collections", "composer"]);
    expect(focus.cycle()).toBe("composer");
    expect(focus.cycle()).toBe("collections");
  });

  test("cycle wraps around at the end", () => {
    const focus = new FocusRegistry();
    for (const id of ["a", "b", "c"]) focus.register(id);
    focus.focus("c");
    expect(focus.cycle()).toBe("a");
  });

  test("cycling backward (shift+tab) wraps around at the start", () => {
    const focus = new FocusRegistry();
    for (const id of ["a", "b", "c"]) focus.register(id);
    focus.focus("a");
    expect(focus.cycleBack()).toBe("c");
  });

  test("a single pane stays focused under cycling", () => {
    const focus = new FocusRegistry();
    focus.register("only");
    expect(focus.cycle()).toBe("only");
    expect(focus.cycleBack()).toBe("only");
    expect(focus.focused).toBe("only");
  });

  test("cycling with no panes is a no-op returning null", () => {
    const focus = new FocusRegistry();
    expect(focus.focused).toBeNull();
    expect(focus.cycle()).toBeNull();
    expect(focus.cycleBack()).toBeNull();
  });

  test("unregistering the focused pane moves focus to the next registration", () => {
    const focus = new FocusRegistry();
    focus.register("a");
    focus.register("b");
    focus.register("c");
    focus.focus("b");
    focus.unregister("b");
    expect(focus.focused).toBe("c");
  });

  test("unregistering the last focused pane wraps focus to the first", () => {
    const focus = new FocusRegistry();
    focus.register("a");
    focus.register("b");
    focus.focus("b");
    focus.unregister("b");
    expect(focus.focused).toBe("a");
  });

  test("unregistering the only pane leaves nothing focused", () => {
    const focus = new FocusRegistry();
    focus.register("only");
    focus.unregister("only");
    expect(focus.focused).toBeNull();
    expect(focus.cycle()).toBeNull();
  });

  test("unregistering a non-focused pane keeps focus stable", () => {
    const focus = new FocusRegistry();
    focus.register("a");
    focus.register("b");
    focus.unregister("b");
    expect(focus.focused).toBe("a");
  });

  test("unregistering an absent id is a no-op", () => {
    const focus = new FocusRegistry();
    expect(() => focus.unregister("ghost")).not.toThrow();
  });

  test("registering the same id twice is rejected", () => {
    const focus = new FocusRegistry();
    focus.register("a");
    expect(() => focus.register("a")).toThrow(DuplicatePaneError);
  });

  test("focusing an unregistered id is rejected", () => {
    const focus = new FocusRegistry();
    expect(() => focus.focus("ghost")).toThrow(UnknownPaneError);
  });

  test("focus() moves focus to any registered pane directly", () => {
    const focus = new FocusRegistry();
    focus.register("a");
    focus.register("b");
    focus.focus("b");
    expect(focus.focused).toBe("b");
  });
});
