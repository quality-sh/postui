import { basename } from "node:path";
import { createCliRenderer } from "@opentui/core";
import { startShell } from "./shell.ts";
import { THEME } from "./theme.ts";

export interface TuiOptions {
  readonly workspaceName: string;
  readonly envBadge: string;
}

/**
 * Run the TUI until the user quits, then fully restore the terminal.
 *
 * createCliRenderer() takes the terminal into the alternate screen;
 * destroy() (in finally, so every exit path restores) leaves it again,
 * resets the background color and the cursor. Quit resolves with exit
 * status 0; renderer startup failures surface as thrown errors.
 */
export async function runTui(options: TuiOptions): Promise<number> {
  const renderer = await createCliRenderer({
    backgroundColor: THEME.color.bg,
    exitOnCtrlC: false,
  });
  let shell: ReturnType<typeof startShell>;
  try {
    shell = startShell(renderer, options);
  } catch (e) {
    // The renderer is already on the alternate screen; a failed shell build
    // must still leave the terminal exactly as it found it.
    renderer.destroy();
    throw e;
  }
  try {
    await shell.onQuit;
    return 0;
  } finally {
    shell.dispose();
    renderer.destroy();
  }
}

/** Default header content derived from the invocation context, not the workspace. */
export function tuiOptionsFromEnvironment(cwd: string): TuiOptions {
  return {
    workspaceName: basename(cwd) || "workspace",
    envBadge: process.env.POSTUI_ENV ?? "DEV",
  };
}
