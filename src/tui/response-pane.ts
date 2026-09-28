import { BoxRenderable, ScrollBoxRenderable } from "@opentui/core";
import type { CliRenderer, Renderable } from "@opentui/core";
import { readdir } from "node:fs/promises";
import { DEFAULT_BODY_WINDOW } from "../send/response.ts";
import type { SendResult } from "../send/send.ts";
import type { SendTarget } from "./composer-send.ts";
import { fxClock } from "./fx/clock.ts";
import type { ParsedKeyLike } from "./keymap.ts";
import { clearChildren } from "./render.ts";
import type { BusyHeader, SendStamp, SendTicket } from "./response-header.ts";
import { renderResponsePane } from "./response-render.ts";
import type { RenderReveal, ResponseRenderState } from "./response-render.ts";
import { THEME } from "./theme.ts";

/** The pane id used in the shell's focus registry (tab order). */
export const RESPONSE_PANE_ID = "response";

/**
 * Widening cap for the body window. Progressive disclosure stays bounded —
 * this is the TUI's --body-bytes, and like the CLI it has no unbounded mode
 * (rule_agent_body_cap).
 */
export const MAX_BODY_WINDOW = 1024 * 1024;

type ResponseTab = "body" | "headers" | "tests";

const TABS: readonly ResponseTab[] = ["body", "headers", "tests"];

/**
 * Rows renderResponsePane() puts first and that stay put while the content
 * under them scrolls: the status line and the BODY/HEADERS/TESTS strip.
 */
const FIXED_ROWS = 2;

/** Scroll keys: ↑/↓, with j/k as silent aliases. */
const SCROLL_KEYS: Readonly<Record<string, 1 | -1>> = { down: 1, j: 1, up: -1, k: -1 };

/** Tab keys: ←/→, with h/l as silent aliases. */
const TAB_KEYS: Readonly<Record<string, 1 | -1>> = { right: 1, l: 1, left: -1, h: -1 };

type ResponseView = ResponseRenderState["view"];

export interface ResponsePaneOptions {
  /** The workspace's generated-tests folder (root/tests), for the TESTS tab. */
  readonly testsDir: string;
  /**
   * Called after +/- changes the body window (the excerpt's byte cap, 256 B
   * by default — the only way to see past it); the composer re-sends through
   * the pipeline. Returns false when the re-send could not start (in
   * flight) — the window then stays where it is, so the pane's note about
   * its window always matches the excerpt it shows.
   */
  readonly onWindowChange: (window: number) => boolean;
}

export interface ResponsePane {
  readonly pane: BoxRenderable;
  readonly bodyWindow: number;
  /** Rows the content is scrolled by (0 at the top, or when nothing scrolls). */
  readonly scrollTop: number;
  /** Handle a keypress while the pane is focused; true = consumed. */
  handleKey(key: ParsedKeyLike): boolean;
  /**
   * The busy view: spinner, request label and elapsed count on the header,
   * skeleton fog in the body. Without a ticket the send is unnumbered and
   * counts from now.
   */
  showSending(ticket?: SendTicket): void;
  /** Name the request in flight (the label updates in place; nothing restarts). */
  describeSending(target: SendTarget): void;
  /**
   * A settled send. `stamp` (`#N · HH:MM:SS`) marks which send it was; the
   * content develops in on each tab's first show, seeded by the number.
   */
  showResult(
    result: SendResult,
    latencyMs: number,
    extraSecrets?: string[],
    forName?: string,
    stamp?: SendStamp | null,
  ): void;
  showError(error: unknown, stamp?: SendStamp | null): void;
  /** Transient diagnostic text (e.g. "send already in flight"). */
  showNote(text: string): void;
  /** Point the TESTS tab at a request; clears any previous response. */
  setRequestName(name: string | null): void;
  /** Resolves when any background work (the tests listing) has finished. */
  settled(): Promise<void>;
}

interface TestsListing {
  /** The request name the listing was read for (staleness marker). */
  forName: string | null;
  files: string[];
  error: unknown;
}

/**
 * The response pane: status line (status code, latency, size), BODY/HEADERS/
 * TESTS tabs, bounded body with progressive disclosure, and the diagnostic
 * region where named typed errors surface. Keys: ↑/↓ scroll a result's
 * content under the fixed status line and tabs, ←/→ switch tabs (j/k/h/l
 * as silent aliases), +/- re-send with a wider/narrower body window. Every rendered byte of a send is
 * scrubbed against the send's resolved env values — the same final pass the
 * CLI's digest does, with no way to turn it off.
 */
export function startResponsePane(renderer: CliRenderer, options: ResponsePaneOptions): ResponsePane {
  const pane = new BoxRenderable(renderer, {
    flexGrow: 1,
    width: "100%",
    border: true,
    borderStyle: "rounded",
    borderColor: THEME.color.border,
    title: "RESPONSE",
    titleColor: THEME.color.text,
    backgroundColor: THEME.color.panel,
    paddingX: 1,
  });

  const state = {
    tab: "body" as ResponseTab,
    bodyWindow: DEFAULT_BODY_WINDOW,
    view: { kind: "idle" } as ResponseView,
    note: null as string | null,
    requestName: null as string | null,
    tests: { forName: null, files: [], error: undefined } as TestsListing,
  };

  let tail: Promise<void> = Promise.resolve();
  const enqueue = (step: () => Promise<void>): Promise<void> => {
    const done = tail.then(step, step);
    tail = done;
    return done;
  };

  /** The scrollable content region of the last render; null when nothing scrolls. */
  let scrollArea: ScrollBoxRenderable | null = null;
  /** The busy header of the last render, while a send is in flight. */
  let busy: BusyHeader | null = null;
  /**
   * The develop reveal: tabs not yet shown since the last settled send
   * develop in on their first show, seeded by the send number.
   */
  const reveal = { seed: 0, pending: new Set<ResponseTab>() };

  /** This render's reveal, if the current tab still owes one (consumed here). */
  const takeReveal = (): RenderReveal | null => {
    const { view } = state;
    if (view.kind !== "result" && view.kind !== "error") return null;
    if (!reveal.pending.has(state.tab) || fxClock().instant) return null;
    // A tests listing still being read develops once it arrives.
    if (view.kind === "result" && state.tab === "tests" && state.tests.forName !== state.requestName) return null;
    // An error reads the same on every tab: it develops once.
    if (view.kind === "error") reveal.pending.clear();
    else reveal.pending.delete(state.tab);
    return { seed: reveal.seed };
  };

  /** A settled send: every tab owes a develop. */
  const revealAll = (stamp: SendStamp | null): void => {
    reveal.seed = stamp?.number ?? 0;
    for (const tab of TABS) reveal.pending.add(tab);
  };

  const render = (): void => {
    // A scroll box listens on the renderer; destroy it, not just detach it.
    scrollArea?.destroyRecursively();
    scrollArea = null;
    clearChildren(pane);
    const renderState: ResponseRenderState = {
      tab: state.tab,
      bodyWindow: state.bodyWindow,
      view: state.view,
      note: state.note,
      requestName: state.requestName,
      tests: state.tests,
    };
    busy = renderResponsePane(renderer, pane, renderState, takeReveal());
    // Only a result can outgrow the pane; the idle/sending/error states are
    // short and center themselves, which a scroll region would undo.
    // A JSON body brings its own scrolling code block; nesting it in a second
    // scroll box would collapse it, so the keys drive that block instead.
    if (state.view.kind === "result") scrollArea = innerScroll(pane) ?? scrollContent(renderer, pane);
  };

  /** Fresh tests listing for the current request; re-renders when done. */
  const readTests = (): Promise<void> =>
    enqueue(async () => {
      const name = state.requestName;
      if (name === null) {
        state.tests = { forName: null, files: [], error: undefined };
        return;
      }
      try {
        const entries = await readdir(options.testsDir);
        const files = entries.filter(entry => entry === `${name}.test.ts`);
        state.tests = { forName: name, files, error: undefined };
      } catch (error) {
        // A missing tests/ folder is the honest "no generated tests" state,
        // not an error; anything else (permissions) is named.
        const code = (error as { code?: unknown }).code;
        state.tests =
          code === "ENOENT"
            ? { forName: name, files: [], error: undefined }
            : { forName: name, files: [], error };
      }
      render();
    });

  const stepTab = (delta: 1 | -1): void => {
    const index = TABS.indexOf(state.tab);
    state.tab = TABS[(index + delta + TABS.length) % TABS.length] as ResponseTab;
    if (state.tab === "tests" && state.tests.forName !== state.requestName) {
      void readTests();
    }
    render();
  };

  const resizeWindow = (next: number): boolean => {
    if (state.view.kind !== "result") return false; // nothing to widen yet
    if (next === state.bodyWindow) return false; // cap reached either way
    if (!options.onWindowChange(next)) return true; // key consumed; window unchanged
    state.bodyWindow = next;
    render();
    return true;
  };

  const handleKey = (key: ParsedKeyLike): boolean => {
    if (key.ctrl) return false;
    if (key.name === "+" || key.name === "=") {
      return resizeWindow(Math.min(state.bodyWindow * 2, MAX_BODY_WINDOW));
    }
    if (key.name === "-") {
      return resizeWindow(Math.max(DEFAULT_BODY_WINDOW, Math.floor(state.bodyWindow / 2)));
    }
    const scroll = SCROLL_KEYS[key.name];
    if (scroll !== undefined) {
      if (scrollArea === null) return false; // nothing to scroll
      scrollArea.scrollBy(scroll);
      return true;
    }
    const tab = TAB_KEYS[key.name];
    if (tab !== undefined) {
      stepTab(tab);
      return true;
    }
    return false;
  };

  render();

  return {
    pane,
    get bodyWindow(): number {
      return state.bodyWindow;
    },
    get scrollTop(): number {
      return scrollArea?.scrollTop ?? 0;
    },
    handleKey,
    showSending(ticket?: SendTicket): void {
      state.view = { kind: "sending", ticket: ticket ?? { number: 0, startedAt: fxClock().now(), target: null } };
      state.note = null;
      render();
    },
    describeSending(target: SendTarget): void {
      if (state.view.kind !== "sending") return;
      state.view = { kind: "sending", ticket: { ...state.view.ticket, target } };
      busy?.setTarget(target);
    },
    showResult(
      result: SendResult,
      latencyMs: number,
      extraSecrets: string[] = [],
      forName = "",
      stamp: SendStamp | null = null,
    ): void {
      state.view = { kind: "result", result, latencyMs, extraSecrets, forName, stamp };
      state.note = null;
      revealAll(stamp);
      render();
    },
    showError(error: unknown, stamp: SendStamp | null = null): void {
      state.view = { kind: "error", error, stamp };
      state.note = null;
      revealAll(stamp);
      render();
    },
    showNote(text: string): void {
      state.note = text;
      render();
    },
    setRequestName(name: string | null): void {
      state.requestName = name;
      state.view = { kind: "idle" };
      state.note = null;
      state.tab = "body";
      render();
      void readTests();
    },
    settled: () => tail,
  };
}

/** The first scroll box already rendered under the pane, if any. */
function innerScroll(node: Renderable): ScrollBoxRenderable | null {
  for (const child of node.getChildren()) {
    if (child instanceof ScrollBoxRenderable) return child;
    const found = innerScroll(child);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Move everything under the fixed rows into a scroll box that fills the
 * rest of the pane, so ↑/↓ (and the mouse wheel) scroll the content while
 * the status line and tabs stay in view. A fresh render starts at the top.
 */
function scrollContent(renderer: CliRenderer, pane: BoxRenderable): ScrollBoxRenderable {
  // flexBasis 0: the area fills what the pane has left instead of sizing the
  // pane to its content (a long body would otherwise squeeze the composer).
  const area = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minHeight: 0,
    width: "100%",
    scrollY: true,
    scrollX: false,
    backgroundColor: THEME.color.panel,
    verticalScrollbarOptions: {
      trackOptions: { foregroundColor: THEME.color.dim, backgroundColor: THEME.color.panel },
    },
  });
  for (const child of pane.getChildren().slice(FIXED_ROWS)) {
    pane.remove(child);
    area.add(child);
  }
  pane.add(area);
  return area;
}
