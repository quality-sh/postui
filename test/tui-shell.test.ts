import { describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { COLLECTIONS_PANE_ID, startShell } from "../src/tui/shell.ts";
import { THEME } from "../src/tui/theme.ts";
import { flatSpans, frameText } from "./helpers/tui-capture.ts";

const WIDTH = 100;
const HEIGHT = 24;

async function setupShell() {
  const setup: TestRendererSetup = await createTestRenderer({
    width: WIDTH,
    height: HEIGHT,
  });
  const shell = startShell(setup.renderer, {
    workspaceName: "api-workspace",
    envBadge: "DEV",
    // A folder that does not exist reads as "no saved requests yet".
    requestsDir: "/nonexistent/postui-shell-test/requests",
  });
  await shell.collections.ready;
  return { ...setup, shell };
}

describe("postui tui shell", () => {
  test("renders the header: wordmark, workspace name, env badge", async () => {
    const setup = await setupShell();
    await setup.renderOnce();
    const text = frameText(setup, HEIGHT);
    expect(text).toContain("P O S T U I");
    expect(text).toContain("api-workspace");
    expect(text).toContain("DEV");
  });

  test("renders the status bar with the mockup key map", async () => {
    const setup = await setupShell();
    await setup.renderOnce();
    const text = frameText(setup, HEIGHT);
    expect(text).toContain("j/k navigate");
    expect(text).toContain("tab focus");
    expect(text).toContain("⏎ run");
    expect(text).toContain("/ search");
    expect(text).toContain("q quit");
  });

  test("renders the collections pane's honest empty state for a missing requests folder", async () => {
    const setup = await setupShell();
    await setup.renderOnce();
    const text = frameText(setup, HEIGHT);
    expect(text).toContain("COLLECTIONS");
    expect(text).toContain("no saved requests found");
    expect(text).toContain("in requests/");
    expect(text).toContain("save one with");
    expect(text).toContain("postui save");
  });

  test("the wordmark is painted in the pink/red accent from the theme", async () => {
    const setup = await setupShell();
    await setup.renderOnce();
    const accent = RGBA.fromHex(THEME.color.accent);
    const wordmark = flatSpans(setup).find((span) => span.text.includes("P O S T U I"));
    expect(wordmark?.fg.equals(accent)).toBe(true);
  });

  test("the focused pane's border repaints in accent while other chrome stays muted", async () => {
    const setup = await setupShell();
    await setup.renderOnce();
    const accent = RGBA.fromHex(THEME.color.accent);
    const muted = RGBA.fromHex(THEME.color.border);
    const spans = flatSpans(setup);
    // Border glyphs of the focused collections pane are painted accent...
    const accentBorder = spans.filter(
      (span) => span.fg.equals(accent) && /[─│┌┐└┘]/.test(span.text),
    );
    expect(accentBorder.length).toBeGreaterThan(0);
    // ...while the header/status borders stay muted.
    const mutedBorder = spans.filter(
      (span) => span.fg.equals(muted) && /[─│┌┐└┘]/.test(span.text),
    );
    expect(mutedBorder.length).toBeGreaterThan(0);
    expect(setup.shell.focus.focused).toBe(COLLECTIONS_PANE_ID);
  });

  test("tab cycles focus through the registry; single pane keeps focus", async () => {
    const { shell, mockInput, flush } = await setupShell();
    mockInput.pressTab();
    await flush();
    expect(shell.focus.focused).toBe(COLLECTIONS_PANE_ID);
  });

  test("q resolves quit; the shell detaches cleanly", async () => {
    const { shell, mockInput, flush } = await setupShell();
    let quit = false;
    void shell.onQuit.then(() => {
      quit = true;
      return quit;
    });
    mockInput.pressKey("x");
    await flush();
    expect(quit).toBe(false);
    mockInput.pressKey("q");
    await flush();
    expect(quit).toBe(true);
    expect(() => shell.dispose()).not.toThrow();
  });

  test("shift+tab cycles backward", async () => {
    const { shell, mockInput, flush } = await setupShell();
    mockInput.pressTab({ shift: true });
    await flush();
    expect(shell.focus.focused).toBe(COLLECTIONS_PANE_ID);
  });
});
