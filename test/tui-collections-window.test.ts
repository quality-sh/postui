import { describe, expect, test } from "bun:test";
import type { LoadedRequest } from "../src/gen/load.ts";
import { flattenRows, steppedRequestRow } from "../src/tui/collections-rows.ts";
import {
  clampWindow,
  visibleRowCount,
  windowForCursor,
  windowSlots,
} from "../src/tui/collections-window.ts";

/** A fake loaded request; identity (object identity) is what matters. */
function req(name: string): LoadedRequest {
  return { name, path: `${name}.ts`, request: { method: "GET", url: `https://x.test/${name}`, headers: {}, body: null } } as LoadedRequest;
}

const b = req("b");
const a = req("a");
const items = [b, a];
const groups = [
  { title: "A", requests: [a] },
  { title: "B", requests: [b] },
];

describe("flattenRows", () => {
  test("browse mode: group headers interleaved, rows carry items indexes", () => {
    const rows = flattenRows(items, groups, null);
    expect(rows.map(row => (row.kind === "header" ? `#${row.title}` : row.request.name))).toEqual([
      "#A", "a", "#B", "b",
    ]);
    // The request rows carry their TRUE items index, not display position.
    expect(rows.filter(row => row.kind === "request").map(row => (row.kind === "request" ? row.index : -1))).toEqual([1, 0]);
  });

  test("filter mode: flat ranked list, rows index the match list", () => {
    const rows = flattenRows(items, groups, [b]);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.kind).toBe("request");
    if (row?.kind === "request") {
      expect(row.request.name).toBe("b");
      expect(row.index).toBe(0);
    }
  });
});

describe("steppedRequestRow", () => {
  const rows = flattenRows(items, groups, null);

  test("steps through DISPLAYED order, wrapping at both ends", () => {
    // Display order: a (items 1), b (items 0).
    expect(steppedRequestRow(rows, 1, 1)?.index).toBe(0); // a -> b
    expect(steppedRequestRow(rows, 0, 1)?.index).toBe(1); // b wraps -> a
    expect(steppedRequestRow(rows, 1, -1)?.index).toBe(0); // a wraps back -> b
    expect(steppedRequestRow(rows, 0, -1)?.index).toBe(1); // b -> a
  });

  test("from no cursor, j picks the first displayed request, k the last", () => {
    expect(steppedRequestRow(rows, null, 1)?.index).toBe(1);
    expect(steppedRequestRow(rows, null, -1)?.index).toBe(0);
  });

  test("a stale cursor index falls back to the ends; empty rows give null", () => {
    expect(steppedRequestRow(rows, 99, 1)?.index).toBe(1);
    expect(steppedRequestRow([], 0, 1)).toBeNull();
  });
});

describe("scroll window", () => {
  test("visibleRowCount derives from the terminal height with chrome, floored at 1", () => {
    // header (3) + status bar (1) + the pane's frame (2)
    expect(visibleRowCount(36)).toBe(30);
    expect(visibleRowCount(7)).toBe(1);
    expect(visibleRowCount(3)).toBe(1);
  });

  test("windowForCursor scrolls down only when the selected row overflows", () => {
    // rows: header(1) + request(1) + header(1) + request(1) => height 4
    const rows = flattenRows(items, groups, null);
    const visible = 2;
    // Cursor on the first request (offset 1): no scroll needed.
    expect(windowForCursor(rows, 1, visible, 0)).toBe(0);
    // Cursor on the second request (offset 3): rows 2..3 need start 2.
    expect(windowForCursor(rows, 3, visible, 0)).toBe(2);
    // Scrolling back up to a group's first row brings its header along:
    // the window never splits a header from its rows.
    expect(windowForCursor(rows, 1, visible, 2)).toBe(0);
  });

  test("windowForCursor clamps to the layout and ignores unknown rows", () => {
    const rows = flattenRows(items, groups, null);
    expect(windowForCursor(rows, 1, 100, 0)).toBe(0); // tall window never scrolls
    expect(windowForCursor(rows, 99, 5, 2)).toBe(2); // unknown row: unchanged
  });
});

describe("pinned group headers", () => {
  // One group of five: #G, r1..r5 (layout rows 0..5).
  const five = ["r1", "r2", "r3", "r4", "r5"].map(name => req(name));
  const rows = flattenRows(five, [{ title: "G", requests: five }], null);
  const shown = (start: number, visible: number): string[] =>
    windowSlots(rows, start, visible).map(slot =>
      slot.row.kind === "header" ? `${slot.pinned ? "^" : "#"}${slot.row.title}` : slot.row.request.name,
    );

  test("a window that starts mid-group pins the group's header over its rows", () => {
    expect(shown(0, 3)).toEqual(["#G", "r1", "r2"]);
    expect(shown(3, 3)).toEqual(["^G", "r3", "r4"]);
  });

  test("scrolling down keeps the cursor row under the pin", () => {
    // Cursor on r5 (row 5) in a 3-row window: the pin takes one slot, so r4 and r5 show.
    const start = windowForCursor(rows, 5, 3, 0);
    expect(shown(start, 3)).toEqual(["^G", "r4", "r5"]);
  });

  test("scrolling up onto a group's first row starts on its real header", () => {
    expect(windowForCursor(rows, 1, 3, 4)).toBe(0);
    expect(clampWindow(rows, 1, 3)).toBe(0); // a start on the first request is its header
  });

  test("the flat match list and a one-row window never pin", () => {
    const flat = flattenRows(five, [], five);
    expect(windowSlots(flat, 2, 2).some(slot => slot.pinned)).toBe(false);
    expect(windowSlots(rows, 3, 1).map(slot => slot.pinned)).toEqual([false]);
  });
});
