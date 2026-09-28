import { afterAll, describe, expect, test } from "bun:test";
import { BoxRenderable, RGBA } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import type { LoadedRequest } from "../src/gen/load.ts";
import { REQUEST_ROW_HEIGHT, requestRow, treeBranch } from "../src/tui/collections-render.ts";
import type { TreeBranch } from "../src/tui/collections-render.ts";
import { flattenRows } from "../src/tui/collections-rows.ts";
import { THEME } from "../src/tui/theme.ts";
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

/** One request row alone in a 28-wide column (the pane's inner width), rendered. */
async function renderRow(
  request: LoadedRequest,
  selected: boolean,
  branch?: TreeBranch,
): Promise<TestRendererSetup> {
  shared ??= await createTestRenderer({ width: 30, height: REQUEST_ROW_HEIGHT });
  const setup = shared;
  for (const child of setup.renderer.root.getChildren()) setup.renderer.root.remove(child);
  const column = new BoxRenderable(setup.renderer, { width: 28, height: REQUEST_ROW_HEIGHT });
  column.add(requestRow(setup.renderer, request, selected, undefined, branch));
  setup.renderer.root.add(column);
  await setup.renderOnce();
  return setup;
}

/**
 * Whether each method's badge is painted as expected — mutating methods in
 * the accent, safe ones green — rendered one after another on the shared
 * renderer.
 */
async function badgeColorsMatch(methods: readonly string[]): Promise<boolean[]> {
  const [method, ...rest] = methods;
  if (method === undefined) return [];
  const spans = flatSpans(await renderRow(req("m", method), false));
  const badge = spans.find(span => span.text.trim() === method);
  const expected = ["POST", "PUT", "PATCH", "DELETE"].includes(method) ? THEME.color.accent : THEME.color.safe;
  return [badge?.fg.equals(RGBA.fromHex(expected)) === true, ...(await badgeColorsMatch(rest))];
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

describe("requestRow", () => {
  test("the selected row is a box, with the marker outside it", async () => {
    const setup = await renderRow(req("create-user", "POST"), true);
    expect(frameText(setup, REQUEST_ROW_HEIGHT).split("\n").map(line => line.trimEnd())).toEqual([
      " ┌─────────────────────────┐",
      "▶│ POST  create-user       │",
      " └─────────────────────────┘",
    ]);
    const accent = RGBA.fromHex(THEME.color.accent);
    const marker = flatSpans(setup).find(span => span.text.includes("▶"));
    expect(marker?.fg.equals(accent)).toBe(true);
  });

  test("an unselected row is plain, hanging off the tree guide", async () => {
    const setup = await renderRow(req("list-users"), false);
    expect(frameText(setup, REQUEST_ROW_HEIGHT).split("\n").map(line => line.trimEnd())).toEqual([
      " │",
      " ├ GET   list-users",
      " │",
    ]);
  });

  test("the group's last row closes the guide", async () => {
    const setup = await renderRow(req("health"), false, "last");
    expect(frameText(setup, REQUEST_ROW_HEIGHT).split("\n").map(line => line.trimEnd())).toEqual([
      " │",
      " └ GET   health",
      "",
    ]);
  });

  test("a match-list row draws no guide", async () => {
    const setup = await renderRow(req("health"), false, "none");
    expect(frameText(setup, REQUEST_ROW_HEIGHT).split("\n").map(line => line.trimEnd())).toEqual([
      "",
      "   GET   health",
      "",
    ]);
  });

  test("badge and name columns line up between the boxed and the plain rows", async () => {
    const boxed = (await renderRow(req("one", "POST"), true)).captureCharFrame().split("\n")[1] ?? "";
    const plain = (await renderRow(req("two"), false)).captureCharFrame().split("\n")[1] ?? "";
    expect(boxed.indexOf("POST")).toBe(plain.indexOf("GET"));
    expect(boxed.indexOf("one")).toBe(plain.indexOf("two"));
  });

  test("method colors: mutating methods in the accent, safe ones green", async () => {
    const methods = ["POST", "PUT", "PATCH", "DELETE", "GET", "HEAD", "OPTIONS"];
    expect(await badgeColorsMatch(methods)).toEqual(methods.map(() => true));
  });

  test("long names clip with an ellipsis inside the box", async () => {
    const setup = await renderRow(req("a-very-long-request-module-name", "POST"), true);
    const line = frameText(setup, REQUEST_ROW_HEIGHT).split("\n")[1] ?? "";
    expect(line).toContain("a-very-long-reque…");
    expect(line.trimEnd().endsWith("│")).toBe(true); // the name never pushes through the border
  });
});
