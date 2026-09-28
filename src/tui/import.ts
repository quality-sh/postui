import { basename } from "node:path";
import { decodePasteBytes, stripAnsiSequences } from "@opentui/core";
import type { BoxRenderable, CliRenderer, PasteEvent } from "@opentui/core";
import { CurlParseError, parseCurl } from "../curl/parse.ts";
import { extractEnvRefs } from "../save/credentials.ts";
import { SaveNameError, resolveModuleName } from "../save/name.ts";
import { SaveCollisionError, saveRequest } from "../save/save.ts";
import type { SaveResult } from "../save/save.ts";
import { COLLECTIONS_PANE_ID } from "./collections.ts";
import type { CollectionsPane } from "./collections.ts";
import type { ComposerPane } from "./composer.ts";
import { importOverlay, renderImportPrompt } from "./import-render.ts";
import type { ImportField } from "./import-render.ts";
import { globalAction } from "./keymap.ts";
import { notify } from "./fx/notify.ts";
import type { ParsedKeyLike } from "./keymap.ts";
import { errorLine } from "./render.ts";

/**
 * Import a curl from inside the TUI: ctrl+n opens a prompt, the user pastes
 * (or types) a curl, enter saves it. The save is `postui save` itself —
 * saveRequest() parses, derives the name, drops literal credentials and
 * refuses to overwrite — so the TUI adds only the prompt and the hand-off
 * back to the collections pane. Nothing here reads or writes requests/
 * on its own.
 *
 * The prompt is a dialog over the dimmed app rather than a status-bar
 * palette like `/` search: a pasted curl runs to several `\` lines, and a
 * parse error belongs next to the text it is about.
 */

/** A parsed keypress plus the raw text it typed ("A" arrives as name "a"). */
type TypedKey = ParsedKeyLike & { readonly sequence?: string };

/** The panes the import hands the saved request to. */
interface RevealTargets {
  readonly collections: Pick<CollectionsPane, "reveal" | "openHighlighted">;
  readonly composer: Pick<ComposerPane, "loadedName">;
  /** Focus the collections pane (the shell's tab/click path). */
  focusCollections(): void;
  /** Leave a one-line note in the response pane. */
  showNote(text: string): void;
}

/** What the shell hands the prompt: the save target and the panes to reveal in. */
interface ImportWiring {
  /** The workspace's requests folder: where the save pipeline writes. */
  readonly requestsDir: string;
  readonly collections: RevealTargets["collections"];
  readonly composer: RevealTargets["composer"];
  readonly response: { showNote(text: string): void };
  /** The shell's focus move (tab and click share it). */
  focusPane(id: string): void;
  /** Close the `/` palette: the prompt takes over the keys. */
  endSearch(): void;
}

interface ImportPrompt {
  /**
   * First say on every keypress: ctrl+n opens the prompt; while it is open
   * every key but ctrl+c is consumed (true) so nothing leaks to a pane or
   * the global map.
   */
  handleKey(key: ParsedKeyLike): boolean;
}

/**
 * Build the prompt into the shell: the overlay goes on top of `parent`, and
 * bracketed pastes are taken from the renderer's key input (released again
 * when the renderer is destroyed).
 */
export function attachImportPrompt(
  renderer: CliRenderer,
  parent: BoxRenderable,
  wiring: ImportWiring,
): ImportPrompt {
  const prompt = startImportPrompt(renderer, {
    requestsDir: wiring.requestsDir,
    onOpen: wiring.endSearch,
    onSaved: (result) =>
      revealImported(
        {
          collections: wiring.collections,
          composer: wiring.composer,
          focusCollections: () => wiring.focusPane(COLLECTIONS_PANE_ID),
          showNote: (text) => wiring.response.showNote(text),
        },
        result,
      ),
  });
  parent.add(prompt.pane);
  renderer.keyInput.on("paste", prompt.handlePaste);
  renderer.once("destroy", () => renderer.keyInput.off("paste", prompt.handlePaste));
  return prompt;
}

interface ImportPromptOptions {
  readonly requestsDir: string;
  /** The prompt just opened. */
  readonly onOpen: () => void;
  /** A request was saved; the prompt is already closed. */
  readonly onSaved: (result: SaveResult) => Promise<void>;
}

function startImportPrompt(
  renderer: CliRenderer,
  options: ImportPromptOptions,
): ImportPrompt & { readonly pane: BoxRenderable; handlePaste(event: PasteEvent): void } {
  const overlay = importOverlay(renderer);

  const state = {
    active: false,
    curl: "",
    name: "",
    field: "curl" as ImportField,
    error: null as string | null,
    busy: false,
  };

  const render = (): void => {
    overlay.scrim.visible = state.active;
    if (!state.active) return;
    renderImportPrompt(renderer, overlay.dialog, {
      curl: state.curl,
      name: state.name,
      field: state.field,
      error: state.error,
      busy: state.busy,
      derivedName: derivedName(state.curl),
    });
  };

  const open = (): void => {
    state.active = true;
    state.curl = "";
    state.name = "";
    state.field = "curl";
    state.error = null;
    options.onOpen();
    render();
  };

  const close = (): void => {
    state.active = false;
    render();
  };

  /** Insert text into the focused field; the name field stays one line. */
  const insert = (text: string): void => {
    if (state.field === "name") state.name += text.replace(/[\r\n]/g, "");
    else state.curl += normalizeNewlines(text);
    render();
  };

  const backspace = (): void => {
    // One code point, not one UTF-16 unit.
    if (state.field === "name") state.name = [...state.name].slice(0, -1).join("");
    else state.curl = [...state.curl].slice(0, -1).join("");
    render();
  };

  const clearField = (): void => {
    if (state.field === "name") state.name = "";
    else state.curl = "";
    render();
  };

  /**
   * Enter: the `postui save` path into the workspace's requests folder. A
   * failure keeps the prompt open with the error inline so the curl can be
   * fixed in place; a name problem moves the keys to the name field.
   */
  const submit = async (): Promise<void> => {
    state.busy = true;
    state.error = null;
    render();
    const name = state.name.trim();
    let result: SaveResult;
    try {
      result = await saveRequest(state.curl, {
        dir: options.requestsDir,
        name: name === "" ? null : name,
      });
    } catch (error) {
      state.busy = false;
      state.error = importErrorText(error, options.requestsDir);
      if (error instanceof SaveCollisionError || error instanceof SaveNameError) {
        state.field = "name";
      }
      render();
      return;
    }
    state.busy = false;
    close();
    await options.onSaved(result);
  };

  /** Field editing: tab switches field, backspace, and typed characters. */
  const editKey = (key: TypedKey): void => {
    if (key.name === "tab") {
      state.field = state.field === "curl" ? "name" : "curl";
      render();
    } else if (key.name === "backspace") {
      backspace();
    } else if (key.name === "space") {
      insert(" ");
    } else {
      // The raw sequence keeps case ("A" parses as name "a" + shift).
      const text = key.sequence !== undefined && key.sequence !== "" ? key.sequence : key.name;
      if ([...text].length === 1) insert(text);
    }
  };

  const handleKey = (key: TypedKey): boolean => {
    if (!state.active) {
      if (globalAction(key) !== "import") return false;
      open();
      return true;
    }
    if (key.ctrl && key.name === "c") return false; // ctrl+c stays the global quit
    if (state.busy) return true; // the save is writing: hold the keys
    if (key.ctrl) {
      if (key.name === "u") clearField();
    } else if (key.name === "escape" || key.name === "") {
      close(); // a lone ESC byte parses unnamed (see composer's editor)
    } else if (key.name === "return" || key.name === "enter") {
      void submit();
    } else {
      editKey(key);
    }
    return true;
  };

  const handlePaste = (event: PasteEvent): void => {
    if (!state.active || state.busy) return;
    event.preventDefault();
    insert(stripAnsiSequences(decodePasteBytes(event.bytes)));
  };

  render();

  return { pane: overlay.scrim, handleKey, handlePaste };
}

/**
 * Terminals deliver pasted line breaks as CR (tmux, most emulators), and
 * the shell splitter reads only LF as a line continuation after `\`.
 */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** The name `postui save` would pick for this curl, or null while it does not parse. */
function derivedName(curl: string): string | null {
  if (curl.trim() === "") return null;
  try {
    return resolveModuleName({ flag: null, url: parseCurl(curl).spec.url });
  } catch {
    return null;
  }
}

/**
 * One inline error line, worded like `postui save` — minus its CLI-only
 * flags, and with the workspace-relative path the CLI would have printed.
 */
function importErrorText(error: unknown, requestsDir: string): string {
  if (error instanceof SaveCollisionError) {
    // The CLI suggests --force; the TUI never overwrites, so ask for a name.
    const [what = ""] = error.message.split(" — ");
    return `${what.replace(requestsDir, basename(requestsDir))} — type another name`;
  }
  if (error instanceof SaveNameError) {
    return error.message.replace(", or pass --name", ", or type a name");
  }
  if (error instanceof CurlParseError) return `error: ${error.message}`;
  return errorLine(error);
}

/**
 * Show a freshly saved request: the collections pane rescans, highlights
 * it and develops its row in with a pulse (reveal), the composer opens it,
 * and the note says what it needs before it can send. Everything goes
 * through the collections pane's own paths (reveal, open without sending),
 * so the tree and the composer agree on the open request exactly as if the
 * user had navigated to it.
 */
async function revealImported(targets: RevealTargets, result: SaveResult): Promise<void> {
  // Reveal first: the focus move's own rescan then finds nothing new.
  const revealed = targets.collections.reveal(result.name);
  targets.focusCollections();
  await revealed;
  // Open, never send: an import must not fire the request it just saved.
  // A module that was open under this name (re-created after a delete) was
  // reloaded by the rescan, so it opens only when the composer holds
  // something else.
  if (targets.composer.loadedName !== result.name) await targets.collections.openHighlighted();
  targets.showNote(importNote(result));
  notify(`imported ${result.name}`, "success");
}

/**
 * The saved-request note: the name, any flags the parse ignored, literal
 * credentials the pipeline dropped, and the environment names the request
 * needs before a send can resolve — e.g.
 * "saved create-user · set $API_TOKEN to send".
 */
export function importNote(result: SaveResult): string {
  const parts = [`saved ${result.name}`];
  for (const warning of result.warnings) parts.push(`${warning.flag} ignored`);
  if (result.redacted.length > 0) {
    parts.push(
      `${result.redacted.join(", ")} not saved — reference an env var ($NAME) in ${basename(result.path)}`,
    );
  }
  const names = requestEnvNames(result.content);
  if (names.length > 0) parts.push(`set ${names.map(name => `$${name}`).join(", ")} to send`);
  return parts.join(" · ");
}

/**
 * Environment names the saved module references. Only the `request` object
 * counts: the module's header comment explains the `$NAME` syntax and must
 * not read as a reference.
 */
function requestEnvNames(content: string): string[] {
  const start = content.indexOf("export const request");
  return extractEnvRefs(start === -1 ? content : content.slice(start));
}
