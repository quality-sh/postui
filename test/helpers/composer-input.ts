import type { AppSetup } from "./tui-app.ts";

/**
 * Key helpers for the composer tests. The mock swallows a lone ESC byte
 * (the parser buffers it for possible escape sequences), so escape and
 * other chords a terminal may not encode distinctly are emitted as the
 * parsed event a real terminal delivers.
 */
export async function pressEscape(app: AppSetup): Promise<void> {
  app.renderer.keyInput.emit("keypress", { name: "escape", ctrl: false } as never);
  await app.flush();
}

export async function pressCtrl(app: AppSetup, name: string): Promise<void> {
  app.renderer.keyInput.emit("keypress", { name, ctrl: true } as never);
  await app.flush();
}

/** Arrow keys in order, then one flush. */
export async function arrows(app: AppSetup, ...directions: Array<"up" | "down" | "left" | "right">): Promise<void> {
  for (const direction of directions) app.mockInput.pressArrow(direction);
  await app.flush();
}

/** Let a send or save queued by the last key settle, then repaint. */
export async function settle(app: AppSetup): Promise<void> {
  await app.flush();
  await app.shell.composer.settled();
  await app.renderOnce();
}
