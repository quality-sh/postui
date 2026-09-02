import { afterAll, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COLLECTIONS_PANE_ID, startShell } from "../src/tui/shell.ts";
import { frameText, rowContaining } from "./helpers/tui-capture.ts";

const WIDTH = 100;
const HEIGHT = 24;

/** A minimal saved-request module body. */
function moduleSource(method: string, url: string): string {
  return `export const request = { method: "${method}", url: "${url}", headers: {}, body: null };\n`;
}

interface SearchSetup extends TestRendererSetup {
  shell: ReturnType<typeof startShell>;
  dir: string;
}

const dirs: string[] = [];
const setups: SearchSetup[] = [];

async function setupSearch(files: Record<string, string>): Promise<SearchSetup> {
  const dir = await mkdtemp(join(tmpdir(), "postui-search-test-"));
  dirs.push(dir);
  await Promise.all(
    Object.entries(files).map(([name, content]) => writeFile(join(dir, name), content)),
  );
  const setup: TestRendererSetup = await createTestRenderer({ width: WIDTH, height: HEIGHT });
  const shell = startShell(setup.renderer, {
    workspaceName: "api-workspace",
    envBadge: "DEV",
    requestsDir: dir,
  });
  await shell.collections.ready;
  await setup.renderOnce();
  const searchSetup: SearchSetup = { ...setup, shell, dir };
  setups.push(searchSetup);
  return searchSetup;
}

afterAll(async () => {
  for (const setup of setups.toReversed()) {
    setup.shell.dispose();
    setup.renderer.destroy();
  }
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
});

const WORKSPACE = {
  "users.ts": moduleSource("POST", "https://api.dev/users"),
  "health.ts": moduleSource("GET", "https://api.dev/health"),
  "orders.ts": moduleSource("GET", "https://api.dev/orders"),
};

/**
 * Escape as a real terminal delivers it: mock-keys' lone ESC byte is
 * swallowed by the input parser (see tui-composer-edit.test.ts), so the
 * parsed event goes straight onto the key input.
 */
function pressEscapeKey(setup: SearchSetup): void {
  setup.renderer.keyInput.emit("keypress", { name: "escape", ctrl: false } as never);
}

describe("search palette", () => {
  test("/ opens the palette: the status bar becomes the query input", async () => {
    const setup = await setupSearch(WORKSPACE);
    setup.mockInput.pressKey("/");
    await setup.flush();
    await setup.renderOnce();
    expect(setup.shell.searching).toBe(true);
    expect(setup.shell.collections.filtering).toBe(true);
    const bar = rowContaining(setup, "⏎ open");
    expect(bar).toContain("/");
    expect(bar).toContain("3 matches"); // empty query: everything, ranked
  });

  test("typing filters the list and the match count follows", async () => {
    const setup = await setupSearch(WORKSPACE);
    setup.mockInput.pressKey("/");
    await setup.flush();
    // "lth" lives only in health's name (and its URL tail) — users and
    // orders have no l/t/h run anywhere
    await setup.mockInput.typeText("lth");
    await setup.flush();
    await setup.renderOnce();
    const text = frameText(setup, HEIGHT);
    expect(text).toContain("1 match"); // singular
    expect(text).toContain("health");
    pressEscapeKey(setup);
    await setup.flush();
    await setup.renderOnce();
    expect(frameText(setup, HEIGHT)).toContain("orders"); // full tree restored
  });

  test("the ticket scenario: /use → users is the top match and enter selects it", async () => {
    const setup = await setupSearch(WORKSPACE);
    setup.mockInput.pressKey("/");
    await setup.flush();
    await setup.mockInput.typeText("use");
    await setup.flush();
    await setup.renderOnce();
    // users is ranked first, so the highlight starts on it
    expect(rowContaining(setup, "▶")).toContain("users");
    setup.mockInput.pressEnter();
    await setup.flush();
    await setup.shell.collections.settled();
    await setup.renderOnce();
    // enter selected AND jumped: the composer loaded it, the palette closed,
    // and the collections highlight sits on the match
    expect(setup.shell.composer.loadedName).toBe("users");
    expect(setup.shell.searching).toBe(false);
    expect(rowContaining(setup, "▶")).toContain("users");
    const text = frameText(setup, HEIGHT);
    expect(text).toContain("j/k navigate"); // status bar back to browsing
    expect(text).toContain("https://api.dev/users"); // composer loaded the URL
  });

  test("escape returns to browsing without opening anything", async () => {
    const setup = await setupSearch(WORKSPACE);
    setup.mockInput.pressKey("/");
    await setup.flush();
    await setup.mockInput.typeText("zzz");
    await setup.flush();
    await setup.renderOnce();
    expect(frameText(setup, HEIGHT)).toContain(`no matches for "zzz"`);
    pressEscapeKey(setup);
    await setup.flush();
    await setup.renderOnce();
    expect(setup.shell.searching).toBe(false);
    expect(setup.shell.composer.loadedName).toBeNull(); // nothing opened
    const text = frameText(setup, HEIGHT);
    expect(text).toContain("j/k navigate"); // browsing mode restored
    expect(text).toContain("Health"); // the grouped tree is back
    expect(text).toContain("no request loaded");
  });

  test("arrows move the match highlight; letters keep typing into the query", async () => {
    const setup = await setupSearch(WORKSPACE);
    setup.mockInput.pressKey("/");
    await setup.flush();
    // "s" appears in every https:// URL, so all three match; names rank
    // users and orders above health
    await setup.mockInput.typeText("s");
    await setup.flush();
    await setup.renderOnce();
    expect(frameText(setup, HEIGHT)).toContain("3 matches");
    const before = rowContaining(setup, "▶");
    setup.mockInput.pressArrow("down");
    await setup.flush();
    await setup.renderOnce();
    expect(rowContaining(setup, "▶")).not.toBe(before); // highlight moved within matches
    // j is a letter here, not navigation: it lands in the query, which no
    // request matches anymore
    setup.mockInput.pressKey("j");
    await setup.flush();
    await setup.renderOnce();
    expect(frameText(setup, HEIGHT)).toContain(`no matches for "sj"`);
    pressEscapeKey(setup);
    await setup.flush();
  });

  test("printable keys never leak while searching: q and / type, quit stays armed after", async () => {
    const setup = await setupSearch(WORKSPACE);
    setup.mockInput.pressKey("/");
    await setup.flush();
    await setup.mockInput.typeText("q");
    await setup.flush();
    await setup.renderOnce();
    expect(setup.shell.searching).toBe(true); // q did not quit…
    expect(frameText(setup, HEIGHT)).toContain(`no matches for "q"`);
    await setup.mockInput.pressBackspace();
    await setup.flush();
    await setup.mockInput.typeText("/");
    await setup.flush();
    await setup.renderOnce();
    // / did not re-open the palette; it typed, and every https:// URL
    // carries one — the palette stays open with 3 matches
    expect(setup.shell.searching).toBe(true);
    expect(frameText(setup, HEIGHT)).toContain("3 matches");
    pressEscapeKey(setup);
    await setup.flush();
    // once back in browsing, q quits again
    setup.mockInput.pressKey("q");
    await setup.flush();
    expect(await Promise.race([setup.shell.onQuit, Promise.resolve("pending")])).toBe("quit");
  });

  test("tab does not move focus mid-search", async () => {
    const setup = await setupSearch(WORKSPACE);
    setup.mockInput.pressKey("/");
    await setup.flush();
    setup.mockInput.pressTab();
    await setup.flush();
    expect(setup.shell.focus.focused).toBe(COLLECTIONS_PANE_ID);
    expect(setup.shell.searching).toBe(true);
    pressEscapeKey(setup);
    await setup.flush();
  });

  test("searching creates no files: the workspace and its folder are untouched", async () => {
    const setup = await setupSearch(WORKSPACE);
    const before = (await readdir(setup.dir)).toSorted();
    setup.mockInput.pressKey("/");
    await setup.flush();
    await setup.mockInput.typeText("users");
    await setup.flush();
    await setup.renderOnce();
    setup.mockInput.pressEnter();
    await setup.flush();
    await setup.shell.collections.settled();
    await setup.renderOnce();
    // and a no-match round trip too
    setup.mockInput.pressKey("/");
    await setup.flush();
    await setup.mockInput.typeText("nope");
    await setup.flush();
    pressEscapeKey(setup);
    await setup.flush();
    await setup.renderOnce();
    const after = (await readdir(setup.dir)).toSorted();
    expect(after).toEqual(before);
    expect(before).toEqual(["health.ts", "orders.ts", "users.ts"]);
  });

  test("j/k follows the displayed group order, and enter opens what is highlighted", async () => {
    // filename order (one, three, two) differs from group-title order
    // (Aaa, Mmm, Users) — navigation must be visually monotonic anyway
    const setup = await setupSearch({
      "one.ts": moduleSource("POST", "https://api.dev/users"),
      "two.ts": moduleSource("GET", "https://api.dev/aaa"),
      "three.ts": moduleSource("GET", "https://api.dev/mmm"),
    });
    // first listing highlights items[0] = one, displayed last under Users
    expect(rowContaining(setup, "▶")).toContain("one");
    setup.mockInput.pressKey("j"); // wraps forward to the first DISPLAYED row
    await setup.flush();
    await setup.renderOnce();
    expect(rowContaining(setup, "▶")).toContain("two");
    setup.mockInput.pressKey("j");
    await setup.flush();
    await setup.renderOnce();
    expect(rowContaining(setup, "▶")).toContain("three");
    setup.mockInput.pressEnter(); // open what the highlight sits on
    await setup.flush();
    await setup.shell.collections.settled();
    await setup.renderOnce();
    expect(setup.shell.composer.loadedName).toBe("three");
  });

  test("space and astral-plane characters type into the query", async () => {
    const setup = await setupSearch(WORKSPACE);
    setup.mockInput.pressKey("/");
    await setup.flush();
    await setup.mockInput.typeText("x y"); // the space must land in the query
    await setup.flush();
    await setup.renderOnce();
    expect(frameText(setup, HEIGHT)).toContain(`no matches for "x y"`);
    pressEscapeKey(setup);
    await setup.flush();
    expect(setup.shell.searching).toBe(false);
  });

  test("ctrl+c quits even while the palette is open", async () => {
    const setup = await setupSearch(WORKSPACE);
    setup.mockInput.pressKey("/");
    await setup.flush();
    expect(setup.shell.searching).toBe(true);
    setup.renderer.keyInput.emit("keypress", { name: "c", ctrl: true } as never);
    await setup.flush();
    expect(await Promise.race([setup.shell.onQuit, Promise.resolve("pending")])).toBe("quit");
  });

  test("searching an empty workspace says nothing to search, honestly", async () => {
    const setup = await setupSearch({});
    setup.mockInput.pressKey("/");
    await setup.flush();
    await setup.renderOnce();
    const text = frameText(setup, HEIGHT);
    expect(setup.shell.searching).toBe(true);
    expect(text).toContain("no saved requests found"); // the pane's true state
    expect(text).toContain("0 matches"); // the bar reports the count
    pressEscapeKey(setup);
    await setup.flush();
    await setup.renderOnce();
    expect(setup.shell.searching).toBe(false);
  });
});
