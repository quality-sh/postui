import { BoxRenderable, TextRenderable, createCliRenderer } from "@opentui/core";
import type { KeyEvent } from "@opentui/core";
import { highlightJsonValue, type JsonTokenKind } from "../json-highlight.ts";
import { fxClock } from "./clock.ts";
import { cellsFromSpans, developLines } from "./develop.ts";
import { FX } from "./palette.ts";
import { skeletonLines } from "./skeleton.ts";
import { halftoneSpinner } from "./spinner.ts";
import { mountToasts } from "./toast.ts";

/**
 * Eyeball harness for the fx module: `bun src/tui/fx/demo.ts`.
 * d develop (300 ms) · D slow develop (2.4 s) · s/e/i toasts · k skeleton · q quit.
 */

const KIND_COLORS: Record<JsonTokenKind, string> = {
  punctuation: FX.dim,
  key: FX.text,
  string: FX.gold,
  number: FX.iris,
  boolean: FX.iris,
  null: FX.iris,
  plain: FX.text,
};

const SAMPLE = {
  id: 4812,
  name: "Ada Lovelace",
  email: "ada@analytical.engine",
  active: true,
  roles: ["admin", "author"],
  profile: { city: "London", born: 1815, notes: null, bio: "Wrote the first published algorithm for a machine." },
  sessions: [
    { id: "s_01HZX", ip: "10.0.0.14", ok: true, ms: 34 },
    { id: "s_01HZY", ip: "10.0.0.22", ok: false, ms: 212 },
  ],
};

const renderer = await createCliRenderer({ backgroundColor: FX.bg, exitOnCtrlC: false, targetFps: 60 });
const clock = fxClock();
const root = new BoxRenderable(renderer, { flexDirection: "column", padding: 1, gap: 1, width: "100%", height: "100%" });
renderer.root.add(root);

const label = (content: string, fg: string = FX.muted): TextRenderable => new TextRenderable(renderer, { content, fg });
root.add(label("postui fx demo   d develop · D slow develop · s/e/i toast · k skeleton · q quit", FX.dim));

const busyRow = (width: number, glyphs: "dots" | "braille", text: string): TextRenderable => {
  const row = new BoxRenderable(renderer, { flexDirection: "row", gap: 1, height: 1 });
  row.add(halftoneSpinner(renderer, { width, glyphs }));
  const status = label(text, FX.text);
  row.add(status);
  root.add(row);
  return status;
};
const elapsed = busyRow(4, "dots", "GET /users · 0ms");
busyRow(5, "braille", "POST /orders · sending…");
const started = clock.now();
clock.every(40, () => {
  elapsed.content = `GET /users · ${Math.round(clock.now() - started)}ms`;
});

const skeletonSlot = new BoxRenderable(renderer, { height: 5, width: 64 });
root.add(skeletonSlot);
let skeleton = skeletonLines(renderer, { lines: 5, width: 64 });
skeletonSlot.add(skeleton);

const panel = new BoxRenderable(renderer, {
  backgroundColor: FX.panel,
  padding: 1,
  flexGrow: 1,
  width: "100%",
  flexDirection: "column",
});
root.add(panel);
panel.add(label("press d to develop a response body"));

const toasts = mountToasts(renderer, renderer.root);
let sends = 0;

function develop(durationMs: number): void {
  for (const child of panel.getChildren()) child.destroyRecursively();
  sends += 1;
  const spans = highlightJsonValue(SAMPLE).lines.map(line => line.map(span => ({ text: span.text, fg: KIND_COLORS[span.kind] })));
  const body = developLines(renderer, cellsFromSpans(spans, { wrap: renderer.width - 6 }), {
    durationMs,
    seed: sends,
    onDone: () => toasts.show(`developed body #${sends} in ${durationMs}ms`, "info"),
  });
  panel.add(body);
}

function restartSkeleton(): void {
  skeleton.destroyRecursively();
  skeleton = skeletonLines(renderer, { lines: 5, width: 64 });
  skeletonSlot.add(skeleton);
}

renderer.keyInput.on("keypress", (key: KeyEvent) => {
  if (key.name === "q" || (key.ctrl && key.name === "c")) {
    renderer.destroy();
    process.exit(0);
  }
  if (key.sequence === "D") develop(2400);
  else if (key.name === "d") develop(300);
  else if (key.name === "s") toasts.show("saved users.ts", "success");
  else if (key.name === "e") toasts.show("refused: users.ts already exists", "error");
  else if (key.name === "i") toasts.show("imported health-check", "info");
  else if (key.name === "k") restartSkeleton();
});
