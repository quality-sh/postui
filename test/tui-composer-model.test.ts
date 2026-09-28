import { describe, expect, test } from "bun:test";
import { splitQuery, withQuery } from "../src/tui/composer-query.ts";
import { maskCredential } from "../src/tui/composer-render-content.ts";
import { DraftSaveRefusedError, draftModule } from "../src/tui/composer-save.ts";
import { tableStep } from "../src/tui/composer-table.ts";
import type { Row } from "../src/tui/composer-table.ts";
import { applyEdit, editActionOf, moveLine, windowAround } from "../src/tui/composer-text.ts";

const EMPTY: Row = ["", ""];

/** "saved", or the refusal message draftModule threw. */
function refused(draft: Parameters<typeof draftModule>[0]): string {
  try {
    draftModule(draft);
    return "saved";
  } catch (error) {
    expect(error).toBeInstanceOf(DraftSaveRefusedError);
    return (error as Error).message;
  }
}

describe("composer text fields", () => {
  test("typed text comes from the key sequence: case and punctuation survive", () => {
    expect(editActionOf({ name: "a", ctrl: false, shift: true, sequence: "A" })).toEqual({ kind: "insert", text: "A" });
    expect(editActionOf({ name: "space", ctrl: false, sequence: " " })).toEqual({ kind: "insert", text: " " });
    expect(editActionOf({ name: "{", ctrl: false, sequence: "{" })).toEqual({ kind: "insert", text: "{" });
    expect(editActionOf({ name: "s", ctrl: true, sequence: "s" })).toBeNull(); // kitty ctrl+s is not typing
    expect(editActionOf({ name: "return", ctrl: false, sequence: "\r" })).toBeNull();
    expect(editActionOf({ name: "delete", ctrl: false, sequence: "\x1b[3~" })).toEqual({ kind: "delete" });
  });

  test("backspace and cursor moves never split an astral character", () => {
    const text = "a😀b";
    expect(applyEdit({ text, cursor: 3 }, { kind: "backspace" })).toEqual({ text: "ab", cursor: 1 });
    expect(applyEdit({ text, cursor: 1 }, { kind: "right" })).toEqual({ text, cursor: 3 });
    expect(applyEdit({ text, cursor: 1 }, { kind: "delete" })).toEqual({ text: "ab", cursor: 1 });
  });

  test("home/end and up/down work per line; the edges hand focus back", () => {
    const text = "one\ntwo long\nx";
    expect(applyEdit({ text, cursor: 6 }, { kind: "home" }).cursor).toBe(4);
    expect(applyEdit({ text, cursor: 6 }, { kind: "end" }).cursor).toBe(12);
    expect(moveLine({ text, cursor: 11 }, "down")?.cursor).toBe(14); // column clamps to the short line
    expect(moveLine({ text, cursor: 11 }, "up")?.cursor).toBe(3);
    expect(moveLine({ text, cursor: 2 }, "up")).toBeNull();
    expect(moveLine({ text, cursor: 14 }, "down")).toBeNull();
  });

  test("a long field scrolls so the cursor stays in view", () => {
    const text = "0123456789";
    expect(windowAround(text, 10, 4)).toEqual({ text: "789", cursor: 3 });
    expect(windowAround(text, 2, 4)).toEqual({ text: "0123", cursor: 2 });
    expect(windowAround("abc", 3, 10)).toEqual({ text: "abc", cursor: 3 });
  });
});

describe("composer params", () => {
  test("the query splits textually and env refs are never percent-encoded", () => {
    const split = splitQuery("https://a.io/x?q=$TERM&flag#top");
    expect(split.rows).toEqual([["q", "$TERM"], ["flag", ""]]);
    expect(withQuery("https://a.io/x?q=$TERM#top", [["q", "$TERM"], ["page", "2"]])).toBe(
      "https://a.io/x?q=$TERM&page=2#top",
    );
  });

  test("separators typed into a row are escaped; no rows means no `?`", () => {
    expect(withQuery("https://a.io/x", [["a=b", "c&d #"]])).toBe("https://a.io/x?a%3Db=c%26d%20%23");
    expect(withQuery("https://a.io/x?a=1", [])).toBe("https://a.io/x");
    expect(withQuery("https://a.io/x?a=%20", [["a", "%20"]])).toBe("https://a.io/x?a=%20"); // escapes survive
  });
});

describe("composer rows", () => {
  test("typing into the add row appends; ctrl+d removes; edges cross name ↔ value", () => {
    const rows: Row[] = [["a", "1"]];
    const typed = tableStep(rows, { row: 1, col: 0, pos: 0 }, { kind: "insert", text: "b" }, EMPTY);
    expect(typed.change).toEqual({ kind: "append", value: ["b", ""] });
    const crossed = tableStep(rows, { row: 0, col: 0, pos: 1 }, { kind: "right" }, EMPTY);
    expect(crossed.cursor).toEqual({ row: 0, col: 1, pos: 0 });
    const back = tableStep(rows, { row: 0, col: 1, pos: 0 }, { kind: "left" }, EMPTY);
    expect(back.cursor).toEqual({ row: 0, col: 0, pos: 1 });
    const removed = tableStep(rows, { row: 0, col: 1, pos: 1 }, { kind: "remove-row" }, EMPTY);
    expect(removed.change).toEqual({ kind: "remove", row: 0 });
    expect(tableStep(rows, { row: 1, col: 0, pos: 0 }, { kind: "remove-row" }, EMPTY).change).toBeNull();
  });

  test("up from the first row leaves the table; backspace on an empty row removes it", () => {
    const rows: Row[] = [["a", "1"], ["", ""]];
    expect(tableStep(rows, { row: 0, col: 0, pos: 0 }, { kind: "up" }, EMPTY).exitUp).toBe(true);
    const step = tableStep(rows, { row: 1, col: 0, pos: 0 }, { kind: "backspace" }, EMPTY);
    expect(step.change).toEqual({ kind: "remove", row: 1 });
    expect(step.cursor).toEqual({ row: 0, col: 1, pos: 1 });
  });
});

describe("composer credentials", () => {
  test("the edit mask keeps env references and hides everything else", () => {
    expect(maskCredential("Bearer $API_TOKEN")).toBe("•••••• $API_TOKEN");
    expect(maskCredential("${A}x$1")).toBe("${A}•••");
    expect(maskCredential("s3cr3t")).toBe("••••••");
  });

  test("save refuses literal credentials, literal userinfo, and URL refs that would not survive", () => {
    const base = { method: "GET", url: "https://api.dev/x", headers: {}, body: null };
    expect(refused({ ...base, headers: { "X-Api-Key": "abc" } })).toContain("X-Api-Key holds a literal credential");
    expect(refused({ ...base, headers: { "X-Api-Key": "$KEY" } })).toBe("saved");
    expect(refused({ ...base, headers: { Authorization: "" } })).toBe("saved"); // empty is not a secret
    expect(refused({ ...base, url: "https://ada:pw@api.dev/x" })).toContain("literal user:password");
    expect(refused({ ...base, url: "https://$HOST/x" })).toContain("env reference in the URL");
    expect(refused({ ...base, url: "not a url" })).toContain("does not parse");
  });

  test("the saved URL is the normalized one the module will hold", () => {
    const saved = draftModule({ method: "GET", url: "https://api.dev", headers: {}, body: null });
    expect(saved.url).toBe("https://api.dev/");
    expect(saved.source).toContain('url: "https://api.dev/"');
  });
});
