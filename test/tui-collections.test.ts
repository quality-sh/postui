import { afterAll, describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COLLECTIONS_PANE_ID, startShell } from "../src/tui/shell.ts";
import { THEME } from "../src/tui/theme.ts";
import { flatSpans, frameText, rowContaining } from "./helpers/tui-capture.ts";

const WIDTH = 100;
const HEIGHT = 24;

/** A minimal saved-request module body, with an optional marker comment for previews. */
function moduleSource(method: string, url: string, marker = ""): string {
  return `// ${marker}\nexport const request = { method: "${method}", url: "${url}", headers: {}, body: null };\n`;
}

interface CollectionsSetup extends TestRendererSetup {
  shell: ReturnType<typeof startShell>;
  dir: string;
}

const dirs: string[] = [];
const setups: CollectionsSetup[] = [];

async function setupCollections(files: Record<string, string> = {}): Promise<CollectionsSetup> {
  const dir = await mkdtemp(join(tmpdir(), "postui-collections-test-"));
  dirs.push(dir);
  await Promise.all(
    Object.entries(files).map(([name, content]) => writeFile(join(dir, name), content)),
  );
  const setup: TestRendererSetup = await createTestRenderer({
    width: WIDTH,
    height: HEIGHT,
  });
  const shell = startShell(setup.renderer, {
    workspaceName: "api-workspace",
    envBadge: "DEV",
    requestsDir: dir,
  });
  await shell.collections.ready;
  await setup.renderOnce();
  const collectionsSetup: CollectionsSetup = { ...setup, shell, dir };
  setups.push(collectionsSetup);
  return collectionsSetup;
}

/**
 * Tab to a scratch pane and back, driving the shell's real key listener so
 * the collections pane's refresh-on-focus runs exactly as a user triggers it.
 * (pressTab sends a real Tab byte; pressKey("tab") would send the letters.)
 */
async function refocus(setup: CollectionsSetup): Promise<void> {
  if (!setup.shell.focus.ids.includes("test-probe")) {
    setup.shell.focus.register("test-probe");
  }
  setup.mockInput.pressTab();
  await setup.flush();
  setup.mockInput.pressTab();
  await setup.flush();
  await setup.shell.collections.settled();
  await setup.renderOnce();
}

afterAll(async () => {
  // Destroy every renderer so the key-input listeners do not pile up
  // (createTestRenderer ones would otherwise warn about leaks).
  for (const setup of setups.toReversed()) {
    setup.shell.dispose();
    setup.renderer.destroy();
  }
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
});

describe("collections pane", () => {
  test("renders every saved request grouped under its collection header", async () => {
    const setup = await setupCollections({
      "create-user.ts": moduleSource("POST", "https://api.dev/users"),
      "list-users.ts": moduleSource("GET", "https://api.dev/users"),
      "health.ts": moduleSource("GET", "https://api.dev/health"),
    });
    const text = frameText(setup, HEIGHT);
    expect(text).toContain("Users");
    expect(text).toContain("Health");
    expect(text).toContain("create-user");
    expect(text).toContain("list-users");
    expect(text).toContain("POST");
    expect(text).toContain("GET");
  });

  test("POST badges are painted in the accent; GET badges muted", async () => {
    const setup = await setupCollections({
      "create-user.ts": moduleSource("POST", "https://api.dev/users"),
      "list-users.ts": moduleSource("GET", "https://api.dev/users"),
    });
    const accent = RGBA.fromHex(THEME.color.accent);
    const dim = RGBA.fromHex(THEME.color.dim);
    const spans = flatSpans(setup);
    const post = spans.find(span => span.text.trim() === "POST");
    const get = spans.find(span => span.text.trim() === "GET");
    expect(post?.fg.equals(accent)).toBe(true);
    expect(get?.fg.equals(dim)).toBe(true);
  });

  test("the first listing places the highlight on the first request, mockup-style", async () => {
    const setup = await setupCollections({
      "alpha.ts": moduleSource("GET", "https://api.dev/health"),
      "beta.ts": moduleSource("POST", "https://api.dev/users"),
    });
    expect(rowContaining(setup, "▶")).toContain("alpha");
  });

  test("j/k moves the highlight with wrap-around at both ends", async () => {
    const setup = await setupCollections({
      "one.ts": moduleSource("POST", "https://api.dev/users"),
      "two.ts": moduleSource("GET", "https://api.dev/users"),
      "three.ts": moduleSource("GET", "https://api.dev/users"),
    });
    // the loader lists modules in lexicographic order: one, three, two
    setup.mockInput.pressKey("j");
    await setup.flush();
    expect(rowContaining(setup, "▶")).toContain("three");
    setup.mockInput.pressKey("k");
    await setup.flush();
    expect(rowContaining(setup, "▶")).toContain("one");
    setup.mockInput.pressKey("k");
    await setup.flush();
    // wrapping backward past the top lands on the last module
    expect(rowContaining(setup, "▶")).toContain("two");
    setup.mockInput.pressKey("j");
    await setup.flush();
    // wrapping forward past the bottom lands back on the first
    expect(rowContaining(setup, "▶")).toContain("one");
  });

  test("the selected row carries the accent selection bar", async () => {
    const setup = await setupCollections({
      "one.ts": moduleSource("POST", "https://api.dev/users"),
      "two.ts": moduleSource("GET", "https://api.dev/users"),
    });
    const accent = RGBA.fromHex(THEME.color.accent);
    const marker = flatSpans(setup).find(span => span.text.includes("▶"));
    expect(marker?.fg.equals(accent)).toBe(true);
  });

  test("enter opens a preview region with the saved module's content", async () => {
    const setup = await setupCollections({
      "create-user.ts": moduleSource("POST", "https://api.dev/users", "create-user body marker"),
    });
    setup.mockInput.pressEnter();
    await setup.flush();
    await setup.shell.collections.settled();
    await setup.renderOnce();
    const text = frameText(setup, HEIGHT);
    expect(text).toContain("PREVIEW");
    expect(text).toContain("create-user.ts");
    expect(text).toContain("create-user body marker");
  });

  test("refresh-on-focus shows a hand edit without a restart", async () => {
    const setup = await setupCollections({
      "edit-me.ts": moduleSource("POST", "https://api.dev/users"),
    });
    await writeFile(
      join(setup.dir, "edit-me.ts"),
      moduleSource("GET", "https://api.dev/health"),
    );
    await refocus(setup);
    const text = frameText(setup, HEIGHT);
    expect(text).toContain("Health"); // regrouped after the URL edit
    expect(text).not.toContain("Users");
    const dim = RGBA.fromHex(THEME.color.dim);
    const get = flatSpans(setup).find(span => span.text.trim() === "GET");
    expect(get?.fg.equals(dim)).toBe(true);
  });

  test("refresh-on-focus also re-reads the open preview's file", async () => {
    const setup = await setupCollections({
      "watched.ts": moduleSource("GET", "https://api.dev/users", "original body marker"),
    });
    setup.mockInput.pressEnter();
    await setup.shell.collections.settled();
    await setup.renderOnce();
    expect(frameText(setup, HEIGHT)).toContain("original body marker");
    await writeFile(
      join(setup.dir, "watched.ts"),
      moduleSource("GET", "https://api.dev/users", "hand-edited body marker"),
    );
    await refocus(setup);
    const text = frameText(setup, HEIGHT);
    expect(text).toContain("hand-edited body marker");
    expect(text).not.toContain("original body marker");
  });

  test("deleting the selected request clears the selection and closes the preview honestly", async () => {
    const setup = await setupCollections({
      "alpha.ts": moduleSource("POST", "https://api.dev/users"),
      "beta.ts": moduleSource("GET", "https://api.dev/users"),
    });
    setup.mockInput.pressEnter(); // open alpha's preview
    await setup.shell.collections.settled();
    await setup.renderOnce();
    expect(frameText(setup, HEIGHT)).toContain("PREVIEW");

    await rm(join(setup.dir, "alpha.ts"));
    await refocus(setup);
    const text = frameText(setup, HEIGHT);
    expect(text).not.toContain("alpha");
    expect(text).not.toContain("PREVIEW");
    expect(text).not.toContain("▶"); // no highlight invented for beta
    expect(text).toContain("beta");
  });

  test("deleting an unselected request keeps the selection on its module", async () => {
    const setup = await setupCollections({
      "alpha.ts": moduleSource("POST", "https://api.dev/users"),
      "beta.ts": moduleSource("GET", "https://api.dev/users"),
    });
    await rm(join(setup.dir, "beta.ts"));
    await refocus(setup);
    expect(rowContaining(setup, "▶")).toContain("alpha");
  });

  test("an empty requests folder renders the honest empty state", async () => {
    const setup = await setupCollections();
    const text = frameText(setup, HEIGHT);
    expect(text).toContain("no saved requests found");
    expect(text).toContain("in requests/");
    expect(text).toContain("save one with");
    expect(text).toContain("postui save");
  });

  test("a malformed module surfaces the loader's named error, then recovers", async () => {
    const setup = await setupCollections({
      "broken.ts": "export const request = {",
    });
    const text = frameText(setup, HEIGHT);
    expect(text).toContain("SavedModuleError");
    expect(text).toContain("broken.ts");
    await rm(join(setup.dir, "broken.ts"));
    await refocus(setup);
    expect(frameText(setup, HEIGHT)).not.toContain("SavedModuleError");
  });

  test("long lists scroll: the window follows the highlight", async () => {
    const files: Record<string, string> = {};
    for (const index of [1, 2, 3, 4, 5, 6, 7, 8]) {
      files[`req${index}.ts`] = moduleSource("GET", "https://api.dev/users");
    }
    const setup = await setupCollections(files);
    // At height 24 the pane shows 16 rows: one header plus five request boxes.
    expect(frameText(setup, HEIGHT)).toContain("req5");
    expect(frameText(setup, HEIGHT)).not.toContain("req6");
    await setup.mockInput.pressKeys(["j", "j", "j", "j", "j"]);
    await setup.flush();
    await setup.renderOnce();
    const text = frameText(setup, HEIGHT);
    expect(text).toContain("req6");
    expect(text).not.toContain("req1"); // scrolled out of the window
  });

  test("pane keys are inert while another pane holds focus", async () => {
    const setup = await setupCollections({
      "one.ts": moduleSource("POST", "https://api.dev/users"),
      "two.ts": moduleSource("GET", "https://api.dev/users"),
    });
    setup.shell.focus.register("composer-probe");
    setup.mockInput.pressTab(); // focus leaves collections
    await setup.flush();
    expect(setup.shell.focus.focused).toBe("composer-probe");
    const before = rowContaining(setup, "▶");
    setup.mockInput.pressKey("j"); // must NOT move the highlight
    await setup.flush();
    expect(rowContaining(setup, "▶")).toBe(before);
  });

  test("enter with nothing highlighted is a no-op", async () => {
    const setup = await setupCollections();
    setup.mockInput.pressEnter();
    await setup.flush();
    await setup.shell.collections.settled();
    await setup.renderOnce();
    expect(frameText(setup, HEIGHT)).not.toContain("PREVIEW");
  });

  test("a module deleted between refresh and enter shows a named read error, not a crash", async () => {
    const setup = await setupCollections({
      "vanishing.ts": moduleSource("POST", "https://api.dev/users"),
    });
    await rm(join(setup.dir, "vanishing.ts")); // behind the pane's back
    setup.mockInput.pressEnter();
    await setup.flush();
    await setup.shell.collections.settled();
    await setup.renderOnce();
    const text = frameText(setup, HEIGHT);
    expect(text).toContain("PREVIEW");
    expect(text).toContain("ReadError");
  });

  test("unicode module names and collections render", async () => {
    const setup = await setupCollections({
      "créer.ts": moduleSource("POST", "https://api.dev/utilisateurs"),
    });
    const text = frameText(setup, HEIGHT);
    expect(text).toContain("créer");
    expect(text).toContain("Utilisateurs");
  });

  test("the pane id stays wired into the shell's focus system", async () => {
    const setup = await setupCollections();
    expect(setup.shell.focus.focused).toBe(COLLECTIONS_PANE_ID);
  });
});
