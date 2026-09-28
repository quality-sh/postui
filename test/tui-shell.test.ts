import { describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { COLLECTIONS_PANE_ID, COMPOSER_PANE_ID, RESPONSE_PANE_ID, startShell } from "../src/tui/shell.ts";
import { THEME } from "../src/tui/theme.ts";
import { flatSpans, frameText, rowContaining } from "./helpers/tui-capture.ts";

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
  test("a renderer destroyed from outside (SIGHUP, SIGTERM) ends the shell as closed", async () => {
    // OpenTUI's own signal handler destroys the renderer but never exits;
    // without this the process outlives its terminal and spins on dead stdin.
    const setup = await setupShell();
    setup.renderer.destroy();
    expect(await setup.shell.onQuit).toBe("closed");
  });

  test("renders the header: wordmark, workspace name, env badge", async () => {
    const setup = await setupShell();
    await setup.renderOnce();
    const text = frameText(setup, HEIGHT);
    expect(text).toContain("P O S T U I");
    expect(text).toContain("api-workspace");
    expect(text).toContain("DEV");
  });

  test("renders the status bar with the focused collections pane's key hints", async () => {
    const setup = await setupShell();
    await setup.renderOnce();
    const text = frameText(setup, HEIGHT);
    expect(text).toContain("↑↓ select");
    expect(text).toContain("tab focus");
    expect(text).toContain("⏎ send");
    expect(text).toContain("/ search");
    expect(text).toContain("q quit");
    expect(text).not.toContain("j/k"); // aliases stay silent
  });

  test("the status bar follows focus: each pane shows its own hints", async () => {
    const setup = await setupShell();
    await setup.renderOnce();
    const bar = (): string => frameText(setup, HEIGHT).split("\n").at(-1) ?? "";
    expect(bar()).toContain("↑↓ select");
    setup.mockInput.pressTab();
    await setup.flush();
    await setup.renderOnce();
    expect(bar()).toContain("type to edit");
    expect(bar()).toContain("←→ tabs");
    expect(bar()).toContain("^s save");
    expect(bar()).toContain("esc leave field");
    expect(bar()).not.toContain("q quit"); // q may be text in a field
    setup.mockInput.pressTab();
    await setup.flush();
    await setup.renderOnce();
    expect(bar()).toContain("↑↓ scroll");
    expect(bar()).toContain("+/- resend ±body");
    setup.mockInput.pressTab();
    await setup.flush();
    await setup.renderOnce();
    expect(bar()).toContain("↑↓ select");
  });

  test("the status bar follows a mouse click-to-focus too", async () => {
    const setup = await setupShell();
    await setup.renderOnce();
    const responseRow = frameText(setup, HEIGHT)
      .split("\n")
      .findIndex(line => line.includes("no response yet"));
    await setup.mockMouse.click(60, responseRow);
    await setup.flush();
    await setup.renderOnce();
    expect(setup.shell.focus.focused).toBe(RESPONSE_PANE_ID);
    expect(frameText(setup, HEIGHT)).toContain("↑↓ scroll");
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

  test("the wordmark fades iris to rose, never the error red", async () => {
    const setup = await setupShell();
    await setup.renderOnce();
    expect(rowContaining(setup, "P O S T U I")).not.toBeNull();
    const spans = flatSpans(setup);
    const letter = (text: string) => spans.find((span) => span.text === text);
    expect(letter("P")?.fg.equals(RGBA.fromHex(THEME.color.accent))).toBe(true);
    expect(letter("I")?.fg.equals(RGBA.fromHex(THEME.color.rose))).toBe(true);
    const love = RGBA.fromHex(THEME.color.love);
    for (const text of ["P", "O", "S", "T", "U", "I"]) expect(letter(text)?.fg.equals(love)).toBe(false);
  });

  test("the focused pane's border repaints in accent while other chrome stays muted", async () => {
    const setup = await setupShell();
    await setup.renderOnce();
    const accent = RGBA.fromHex(THEME.color.accent);
    const muted = RGBA.fromHex(THEME.color.border);
    const spans = flatSpans(setup);
    // Border glyphs of the focused collections pane are painted accent...
    const accentBorder = spans.filter(
      (span) => span.fg.equals(accent) && /[─│╭╮╰╯]/.test(span.text),
    );
    expect(accentBorder.length).toBeGreaterThan(0);
    // ...while the header and the other panes stay at rest.
    const mutedBorder = spans.filter(
      (span) => span.fg.equals(muted) && /[─│╭╮╰╯]/.test(span.text),
    );
    expect(mutedBorder.length).toBeGreaterThan(0);
    expect(setup.shell.focus.focused).toBe(COLLECTIONS_PANE_ID);
  });

  test("tab cycles focus: collections → composer → response → collections", async () => {
    const { shell, mockInput, flush } = await setupShell();
    expect(shell.focus.focused).toBe(COLLECTIONS_PANE_ID);
    mockInput.pressTab();
    await flush();
    expect(shell.focus.focused).toBe(COMPOSER_PANE_ID);
    mockInput.pressTab();
    await flush();
    expect(shell.focus.focused).toBe(RESPONSE_PANE_ID);
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

  test("q does not quit while a text field has focus; ctrl+c still does", async () => {
    let editing = true;
    const setup = await createTestRenderer({ width: WIDTH, height: HEIGHT });
    const shell = startShell(setup.renderer, {
      workspaceName: "api-workspace",
      envBadge: "DEV",
      requestsDir: "/nonexistent/postui-shell-test/requests",
      isEditingText: () => editing,
    });
    await shell.collections.ready;
    let quit = false;
    void shell.onQuit.then(() => {
      quit = true;
      return quit;
    });
    setup.mockInput.pressKey("q");
    await setup.flush();
    expect(quit).toBe(false);
    setup.mockInput.pressKey("/");
    await setup.flush();
    expect(shell.searching).toBe(false); // "/" typed, never opened search
    editing = false;
    setup.mockInput.pressKey("q");
    await setup.flush();
    expect(quit).toBe(true);
    shell.dispose();
    setup.renderer.destroy();
  });

  test("the default text-focus check asks the composer, only while it holds focus", async () => {
    const { shell, mockInput, flush } = await setupShell();
    let quit = false;
    void shell.onQuit.then(() => {
      quit = true;
      return quit;
    });
    // A composer that reports a focused text field (the method is optional).
    Object.assign(shell.composer, { isEditingText: () => true });
    mockInput.pressKey("q"); // collections focused: q quits as usual…
    await flush();
    expect(quit).toBe(true);
    const second = await setupShell();
    let quitSecond = false;
    void second.shell.onQuit.then(() => {
      quitSecond = true;
      return quitSecond;
    });
    Object.assign(second.shell.composer, { isEditingText: () => true });
    second.mockInput.pressTab(); // …but with the composer focused and editing,
    await second.flush();
    second.mockInput.pressKey("q"); // q is text
    await second.flush();
    expect(quitSecond).toBe(false);
    second.mockInput.pressKey("c", { ctrl: true });
    await second.flush();
    expect(quitSecond).toBe(true);
  });

  test("shift+tab cycles backward", async () => {
    const { shell, mockInput, flush } = await setupShell();
    mockInput.pressTab({ shift: true });
    await flush();
    // backward from the first pane wraps to the last
    expect(shell.focus.focused).toBe(RESPONSE_PANE_ID);
  });
});
