import { describe, expect, test } from "bun:test";
import type { LoadedRequest } from "../src/gen/load.ts";
import { flattenRows, steppedRequestRow } from "../src/tui/collections-rows.ts";
import {
  visibleRowCount,
  windowForCursor,
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
    expect(visibleRowCount(36)).toBe(28);
    expect(visibleRowCount(8)).toBe(1);
    expect(visibleRowCount(3)).toBe(1);
  });

  test("windowForCursor scrolls down only when the selection box overflows", () => {
    // rows: header(1) + request(3) + header(1) + request(3) => height 8
    const rows = flattenRows(items, groups, null);
    const visible = 5;
    // Cursor on the first request (offset 1): no scroll needed.
    expect(windowForCursor(rows, 1, visible, 0)).toBe(0);
    // Cursor on the second request (offset 5): box 5..7 needs start 3.
    expect(windowForCursor(rows, 3, visible, 0)).toBe(3);
    // Scrolling back up: the box top becomes the window start (offset 1).
    expect(windowForCursor(rows, 1, visible, 3)).toBe(1);
  });

  test("windowForCursor clamps to the layout and ignores unknown rows", () => {
    const rows = flattenRows(items, groups, null);
    expect(windowForCursor(rows, 1, 100, 0)).toBe(0); // tall window never scrolls
    expect(windowForCursor(rows, 99, 5, 2)).toBe(2); // unknown row: unchanged
  });
});
