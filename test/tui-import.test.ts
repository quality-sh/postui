import { afterAll, describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { globalAction, hintsFor } from "../src/tui/keymap.ts";
import { importNote } from "../src/tui/import.ts";
import { COLLECTIONS_PANE_ID } from "../src/tui/shell.ts";
import { HEIGHT, moduleSource, setupApp, teardownApps } from "./helpers/tui-app.ts";
import type { AppSetup } from "./helpers/tui-app.ts";
import { frameText, rowContaining } from "./helpers/tui-capture.ts";

afterAll(teardownApps);

/** The ticket's curl, as a terminal pastes it: `\` continuations, CR line breaks. */
const CREATE_USER = [
  "curl -X POST http://127.0.0.1:8984/users \\",
  '-H "Authorization: Bearer sk_live_abc123" \\',
  "-d '{\"name\":\"Ada Lovelace\"}'",
].join("\r");

/** ctrl+n as a terminal sends it (0x0e). */
async function openImport(app: AppSetup): Promise<void> {
  app.mockInput.pressKey("\x0e");
  await app.flush();
  await app.renderOnce();
}

/** Escape as a parsed event (mock-keys' lone ESC byte is held by the parser). */
function pressEscapeKey(app: AppSetup): void {
  app.renderer.keyInput.emit("keypress", { name: "escape", ctrl: false } as never);
}

/** True while the import overlay is on screen. */
function importOpen(app: AppSetup): boolean {
  return frameText(app, HEIGHT).includes("IMPORT CURL");
}

/**
 * Re-render until the frame shows `needle`. The save runs on disk I/O the
 * test cannot await directly (the shell keeps the prompt private), so the
 * frame is the signal — the same thing a user waits for.
 */
async function waitForFrame(app: AppSetup, needle: string, tries = 200): Promise<void> {
  await app.flush();
  await app.shell.collections.settled();
  await app.renderOnce();
  if (frameText(app, HEIGHT).includes(needle)) return;
  if (tries === 0) throw new Error(`frame never showed "${needle}":\n${frameText(app, HEIGHT)}`);
  await Bun.sleep(5);
  await waitForFrame(app, needle, tries - 1);
}

/** Enter, then wait until the save lands: its note (success) or ✗ (refused). */
async function submit(app: AppSetup, outcome: string): Promise<void> {
  app.mockInput.pressEnter();
  await waitForFrame(app, outcome);
}

describe("import keys", () => {
  test("ctrl+n maps to the import action; a plain n stays inert", () => {
    expect(globalAction({ name: "n", ctrl: true })).toBe("import");
    expect(globalAction({ name: "n", ctrl: false })).toBeNull();
  });

  test("the collections status bar offers ^n import", () => {
    expect(hintsFor("collections")).toContainEqual({ key: "ctrl+n", label: "import", glyph: "^n" });
  });
});

describe("import prompt", () => {
  test("ctrl+n opens the overlay from any pane and esc cancels without writing", async () => {
    const app = await setupApp();
    app.mockInput.pressTab(); // composer focused: the key is still global
    await app.flush();
    await openImport(app);
    expect(importOpen(app)).toBe(true);
    expect(frameText(app, HEIGHT)).toContain("IMPORT CURL");
    await app.mockInput.typeText("curl https://api.dev/q");
    await app.flush();
    pressEscapeKey(app);
    await app.flush();
    await app.renderOnce();
    expect(importOpen(app)).toBe(false);
    expect(frameText(app, HEIGHT)).not.toContain("IMPORT CURL");
    expect(await readdir(app.requestsDir)).toEqual([]);
  });

  test("a bracketed paste lands as one input; the derived name previews", async () => {
    const app = await setupApp();
    await openImport(app);
    await app.mockInput.pasteBracketedText(CREATE_USER);
    await app.flush();
    await app.renderOnce();
    const text = frameText(app, HEIGHT);
    // three numbered lines: the CR breaks arrived as line breaks, not enters
    expect(text).toContain("1 │ curl -X POST http://127.0.0.1:8984/users \\");
    expect(text).toContain('3 │ -d \'{"name":"Ada Lovelace"}\'');
    expect(rowContaining(app, "name")).toContain("users (derived from the URL)");
    expect(importOpen(app)).toBe(true); // nothing submitted yet
  });

  test("q and / type into the prompt instead of quitting or searching", async () => {
    const app = await setupApp();
    await openImport(app);
    await app.mockInput.typeText("q/Q");
    await app.flush();
    await app.renderOnce();
    expect(app.shell.searching).toBe(false);
    expect(rowContaining(app, "1 │")).toContain("q/Q"); // case survives
  });

  test("enter saves through the save pipeline, then collections and composer show it", async () => {
    const app = await setupApp({ "health.ts": moduleSource("GET", "https://api.dev/health") });
    await openImport(app);
    await app.mockInput.pasteBracketedText(CREATE_USER);
    await app.flush();
    await submit(app, "saved users");

    expect(importOpen(app)).toBe(false);
    const saved = await readFile(join(app.requestsDir, "users.ts"), "utf8");
    expect(saved).toContain('method: "POST"');
    expect(saved).not.toContain("sk_live_abc123"); // the literal credential never lands
    expect(saved).toContain('"Authorization": ""');

    expect(app.shell.focus.focused).toBe(COLLECTIONS_PANE_ID);
    expect(app.shell.composer.loadedName).toBe("users");
    expect(rowContaining(app, "▶")).toContain("users"); // highlighted in the tree
    const text = frameText(app, HEIGHT);
    expect(text).toContain("http://127.0.0.1:8984/users"); // composer loaded the URL
    expect(text).toContain("saved users");
    expect(text).toContain("Authorization header not saved");
  });

  test("a custom name wins over the derived one", async () => {
    const app = await setupApp();
    await openImport(app);
    await app.mockInput.pasteBracketedText("curl https://api.dev/users");
    await app.flush();
    app.mockInput.pressTab(); // curl → name
    await app.flush();
    await app.mockInput.typeText("list-users");
    await app.flush();
    await submit(app, "saved list-users");
    expect(await readdir(app.requestsDir)).toEqual(["list-users.ts"]);
    expect(app.shell.composer.loadedName).toBe("list-users");
  });

  test("a parse error shows inline and the prompt stays open for a fix", async () => {
    const app = await setupApp();
    await openImport(app);
    await app.mockInput.typeText("curl --bogus https://api.dev/users");
    await app.flush();
    await submit(app, "✗");
    expect(importOpen(app)).toBe(true);
    expect(frameText(app, HEIGHT)).toContain("✗ error: unknown curl flag: --bogus");
    expect(await readdir(app.requestsDir)).toEqual([]);

    // fix it in place: clear the field and type a good curl
    app.mockInput.pressKey("u", { ctrl: true });
    await app.flush();
    await app.mockInput.typeText("curl https://api.dev/users");
    await app.flush();
    await submit(app, "saved users");
    expect(importOpen(app)).toBe(false);
    expect(await readdir(app.requestsDir)).toEqual(["users.ts"]);
  });

  test("a name clash is refused inline, the module is untouched, and the name field takes the keys", async () => {
    const existing = moduleSource("GET", "https://api.dev/users");
    const app = await setupApp({ "users.ts": existing });
    await openImport(app);
    await app.mockInput.pasteBracketedText("curl -X DELETE https://api.dev/users");
    await app.flush();
    await submit(app, "✗");
    expect(importOpen(app)).toBe(true);
    const text = frameText(app, HEIGHT);
    expect(text).toContain("✗ requests/users.ts already exists — type another name");
    expect(text).not.toContain("--force");
    expect(await readFile(join(app.requestsDir, "users.ts"), "utf8")).toBe(existing);

    await app.mockInput.typeText("delete-users"); // the name field has the keys now
    await app.flush();
    await submit(app, "saved delete-users");
    expect(importOpen(app)).toBe(false);
    expect((await readdir(app.requestsDir)).toSorted()).toEqual(["delete-users.ts", "users.ts"]);
    expect(app.shell.composer.loadedName).toBe("delete-users");
  });

  test("an env reference in the curl is kept and the note names the variable to set", async () => {
    const app = await setupApp();
    await openImport(app);
    await app.mockInput.pasteBracketedText(
      "curl -X POST https://api.dev/create-user -H 'Authorization: Bearer $API_TOKEN'",
    );
    await app.flush();
    await submit(app, "saved create-user");
    const saved = await readFile(join(app.requestsDir, "create-user.ts"), "utf8");
    expect(saved).toContain('"Authorization": "Bearer $API_TOKEN"');
    expect(frameText(app, HEIGHT)).toContain("saved create-user · set $API_TOKEN to send");
  });

  test("ctrl+n from the search palette closes the palette first", async () => {
    const app = await setupApp({ "health.ts": moduleSource("GET", "https://api.dev/health") });
    app.mockInput.pressKey("/");
    await app.flush();
    await openImport(app);
    expect(app.shell.searching).toBe(false);
    expect(app.shell.collections.filtering).toBe(false);
    expect(importOpen(app)).toBe(true);
  });
});

describe("importNote", () => {
  const base = { path: "requests/ping.ts", name: "ping", content: "", redacted: [], warnings: [] };

  test("the header comment's $NAME example is not a reference", () => {
    const content = "// Values like $NAME resolve\n\nexport const request = { url: \"https://x.dev/$HOST\" };\n";
    expect(importNote({ ...base, content })).toBe("saved ping · set $HOST to send");
  });

  test("ignored flags and dropped credentials are listed", () => {
    expect(
      importNote({
        ...base,
        redacted: ["Authorization header", "URL userinfo"],
        warnings: [{ flag: "-L", message: "follows redirects" }],
      }),
    ).toBe(
      "saved ping · -L ignored · Authorization header, URL userinfo not saved — reference an env var ($NAME) in ping.ts",
    );
  });
});
