import { basename, join } from "node:path";
import { createCliRenderer } from "@opentui/core";
import { attachMotion } from "./motion.ts";
import { startShell } from "./shell.ts";
import { THEME } from "./theme.ts";

export interface TuiOptions {
  readonly workspaceName: string;
  readonly envBadge: string;
  /** The workspace's requests folder, browsed by the collections pane. */
  readonly requestsDir: string;
  /** The workspace's generated-tests folder (response pane's TESTS tab). */
  readonly testsDir?: string;
}

/**
 * Run the TUI until the user quits, then fully restore the terminal.
 *
 * createCliRenderer() takes the terminal into the alternate screen;
 * destroy() (in finally, so every exit path restores) leaves it again,
 * resets the background color and the cursor. Quit resolves with exit
 * status 0; a renderer destroyed by OpenTUI's signal handler (SIGHUP when
 * the terminal closes, SIGTERM) resolves with 1 instead of hanging on;
 * renderer startup failures surface as thrown errors.
 * attachMotion() drives the border-sweep transitions from the renderer's
 * frame loop; detachMotion() (also in finally) lands any in-flight sweep
 * before teardown.
 */
export async function runTui(options: TuiOptions): Promise<number> {
  const renderer = await createCliRenderer({
    backgroundColor: THEME.color.bg,
    exitOnCtrlC: false,
    // 60 fps so sweeps and spinners move smoothly (the default target is
    // 30); stats off, nothing reads them.
    targetFps: 60,
    maxFps: 60,
    gatherStats: false,
    // Kitty keyboard protocol with OpenTUI's defaults (disambiguate +
    // alternate keys): a lone esc arrives at once instead of after the
    // escape-sequence timeout. Terminals without it ignore the request and
    // keep sending legacy bytes, which the parser still reads.
    useKittyKeyboard: {},
  });
  const detachMotion = attachMotion(renderer);
  let shell: ReturnType<typeof startShell>;
  try {
    shell = startShell(renderer, options);
  } catch (e) {
    // The renderer is already on the alternate screen; a failed shell build
    // must still leave the terminal exactly as it found it.
    detachMotion();
    renderer.destroy();
    throw e;
  }
  try {
    // A closed terminal or a signal is not a clean quit: exit 1.
    return (await shell.onQuit) === "quit" ? 0 : 1;
  } finally {
    shell.dispose();
    detachMotion();
    renderer.destroy();
  }
}

/** Default header content derived from the invocation context, not the workspace. */
export function tuiOptionsFromEnvironment(cwd: string): TuiOptions {
  return {
    workspaceName: basename(cwd) || "workspace",
    envBadge: process.env.POSTUI_ENV ?? "DEV",
    requestsDir: join(cwd, "requests"),
    testsDir: join(cwd, "tests"),
  };
}
