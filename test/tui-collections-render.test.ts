import { afterAll, describe, expect, test } from "bun:test";
import { BoxRenderable, RGBA } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import type { LoadedRequest } from "../src/gen/load.ts";
import { REQUEST_ROW_HEIGHT, methodBadge, treeBranch } from "../src/tui/collections-render.ts";
import type { TreeBranch } from "../src/tui/collections-render.ts";
import { flattenRows } from "../src/tui/collections-rows.ts";
import { RowSlot } from "../src/tui/collections-slot.ts";
import { THEME, methodColor } from "../src/tui/theme.ts";
import { flatSpans, frameText } from "./helpers/tui-capture.ts";

/** A fake loaded request; identity (object identity) is what matters. */
function req(name: string, method = "GET"): LoadedRequest {
  return { name, path: `${name}.ts`, request: { method, url: `https://x.test/${name}`, headers: {}, body: null } } as LoadedRequest;
}

// One renderer for the file: each render swaps the root's only child.
let shared: TestRendererSetup | null = null;

afterAll(() => {
  shared?.renderer.destroy();
});

/** One request row (a pane row slot) alone in a 28-wide column (the pane's inner width), rendered. */
async function renderRow(
  request: LoadedRequest,
  selected: boolean,
  branch: TreeBranch = "middle",
): Promise<TestRendererSetup> {
  shared ??= await createTestRenderer({ width: 30, height: REQUEST_ROW_HEIGHT });
  const setup = shared;
  for (const child of setup.renderer.root.getChildren()) setup.renderer.root.remove(child);
  const column = new BoxRenderable(setup.renderer, { width: 28, height: REQUEST_ROW_HEIGHT });
  const slot = new RowSlot(setup.renderer, () => {});
  slot.show({ kind: "request", request, branch, selected });
  column.add(slot.box);
  setup.renderer.root.add(column);
  await setup.renderOnce();
  return setup;
}

/**
 * Whether each method's badge is painted in its method color (theme.ts
 * methodColor), rendered one after another on the shared renderer.
 */
async function badgeColorsMatch(methods: readonly string[]): Promise<boolean[]> {
  const [method, ...rest] = methods;
  if (method === undefined) return [];
  const spans = flatSpans(await renderRow(req("m", method), false));
  const badge = spans.find(span => span.text.trim() === methodBadge(method));
  return [badge?.fg.equals(RGBA.fromHex(methodColor(method))) === true, ...(await badgeColorsMatch(rest))];
}

describe("treeBranch", () => {
  const a1 = req("a1");
  const a2 = req("a2");
  const b1 = req("b1");
  const items = [a1, a2, b1];
  const groups = [
    { title: "A", requests: [a1, a2] },
    { title: "B", requests: [b1] },
  ];

  test("a row with a sibling below is middle; the group's final row is last", () => {
    const rows = flattenRows(items, groups, null);
    // rows: #A, a1, a2, #B, b1
    expect(treeBranch(rows, 1)).toBe("middle");
    expect(treeBranch(rows, 2)).toBe("last"); // the next row is a header
    expect(treeBranch(rows, 4)).toBe("last"); // the end of the list
  });

  test("the flat match list has no headers, so no guides", () => {
    const rows = flattenRows(items, groups, [b1, a1]);
    expect(treeBranch(rows, 0)).toBe("none");
    expect(treeBranch(rows, 1)).toBe("none");
  });
});

/** The rendered row as text, trailing blanks trimmed. */
function rowLine(setup: TestRendererSetup): string {
  return frameText(setup, REQUEST_ROW_HEIGHT).trimEnd();
}

describe("requestRow", () => {
  test("rows are one terminal row: the selection is a bar and a fill, never a box", async () => {
    expect(REQUEST_ROW_HEIGHT).toBe(1);
    const setup = await renderRow(req("create-user", "POST"), true);
    expect(rowLine(setup)).toBe("▌├ POST  create-user");
    const accent = RGBA.fromHex(THEME.color.accent);
    const accentSoft = RGBA.fromHex(THEME.color.accentSoft);
    const spans = flatSpans(setup);
    const bar = spans.find(span => span.text.includes("▌"));
    expect(bar?.fg.equals(accent)).toBe(true);
    // The fill runs under the whole row, name included.
    const name = spans.find(span => span.text.includes("create-user"));
    expect(name?.bg.equals(accentSoft)).toBe(true);
  });

  test("an unselected row is plain, hanging off the tree guide on the pane's own fill", async () => {
    const setup = await renderRow(req("list-users"), false);
    expect(rowLine(setup)).toBe(" ├ GET   list-users");
    const accentSoft = RGBA.fromHex(THEME.color.accentSoft);
    expect(flatSpans(setup).some(span => span.bg.equals(accentSoft))).toBe(false);
  });

  test("the group's last row closes the guide", async () => {
    const setup = await renderRow(req("health"), false, "last");
    expect(rowLine(setup)).toBe(" └ GET   health");
  });

  test("a match-list row draws no guide", async () => {
    const setup = await renderRow(req("health"), false, "none");
    expect(rowLine(setup)).toBe("   GET   health");
  });

  test("badge and name columns line up between the selected and the plain rows", async () => {
    const selected = (await renderRow(req("one", "POST"), true)).captureCharFrame().split("\n")[0] ?? "";
    const plain = (await renderRow(req("two"), false)).captureCharFrame().split("\n")[0] ?? "";
    expect(selected.indexOf("POST")).toBe(plain.indexOf("GET"));
    expect(selected.indexOf("one")).toBe(plain.indexOf("two"));
  });

  test("method colors: GET foam, POST gold, PUT/PATCH rose, DELETE love, HEAD/OPTIONS muted", async () => {
    const methods = ["POST", "PUT", "PATCH", "DELETE", "GET", "HEAD", "OPTIONS"];
    expect(await badgeColorsMatch(methods)).toEqual(methods.map(() => true));
  });

  test("DELETE and OPTIONS badges shorten so the name never touches the badge", async () => {
    expect(rowLine(await renderRow(req("drop-user", "DELETE"), false))).toBe(" ├ DEL   drop-user");
    expect(rowLine(await renderRow(req("preflight", "OPTIONS"), false))).toBe(" ├ OPT   preflight");
    expect(rowLine(await renderRow(req("tweak", "PATCH"), false))).toBe(" ├ PATCH tweak");
  });

  test("long names clip with an ellipsis inside the pane's width", async () => {
    const setup = await renderRow(req("a-very-long-request-module-name", "POST"), true);
    const line = rowLine(setup);
    expect(line).toContain("a-very-long-reques…");
    expect(line.length).toBeLessThanOrEqual(28); // never past the pane's inner width
  });
});
