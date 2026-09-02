import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPOSER_PANE_ID, RESPONSE_PANE_ID, startShell } from "../../src/tui/shell.ts";

const WIDTH = 100;
export const HEIGHT = 30;

/** A minimal saved-request module body. */
export function moduleSource(
  method: string,
  url: string,
  extra: { headers?: Record<string, string>; body?: unknown } = {},
): string {
  const spec: Record<string, unknown> = { method, url, headers: extra.headers ?? {}, body: extra.body ?? null };
  return `// saved module\nexport const request = ${JSON.stringify(spec, null, 2)};\n`;
}

export interface AppSetup extends TestRendererSetup {
  shell: ReturnType<typeof startShell>;
  dir: string;
  requestsDir: string;
  testsDir: string;
}

const dirs: string[] = [];
const setups: AppSetup[] = [];

/** A full app on a temp workspace: shell with composer + response wired. */
export async function setupApp(
  files: Record<string, string> = {},
  testFiles: Record<string, string> = {},
): Promise<AppSetup> {
  const dir = await mkdtemp(join(tmpdir(), "postui-tui-app-"));
  dirs.push(dir);
  const requestsDir = join(dir, "requests");
  const testsDir = join(dir, "tests");
  await mkdir(requestsDir, { recursive: true });
  if (Object.keys(testFiles).length > 0) await mkdir(testsDir, { recursive: true });
  await Promise.all(
    Object.entries(files).map(([name, content]) => writeFile(join(requestsDir, name), content)),
  );
  await Promise.all(
    Object.entries(testFiles).map(([name, content]) => writeFile(join(testsDir, name), content)),
  );
  const setup: TestRendererSetup = await createTestRenderer({ width: WIDTH, height: HEIGHT });
  const shell = startShell(setup.renderer, {
    workspaceName: "api-workspace",
    envBadge: "DEV",
    requestsDir,
    testsDir,
  });
  await shell.collections.ready;
  await setup.renderOnce();
  const app: AppSetup = { ...setup, shell, dir, requestsDir, testsDir };
  setups.push(app);
  return app;
}

/** Enter on the first request (collections starts focused, cursor on row 0). */
export async function openFirstRequest(app: AppSetup): Promise<void> {
  app.mockInput.pressEnter();
  await app.flush();
  await app.shell.collections.settled();
  await app.renderOnce();
}

/** Tab from collections to the composer. */
export async function focusComposer(app: AppSetup): Promise<void> {
  app.mockInput.pressTab();
  await app.flush();
  if (app.shell.focus.focused !== COMPOSER_PANE_ID) {
    throw new Error("expected composer focus");
  }
}

/** Tab from the composer to the response pane. */
export async function focusResponse(app: AppSetup): Promise<void> {
  app.mockInput.pressTab();
  await app.flush();
  if (app.shell.focus.focused !== RESPONSE_PANE_ID) {
    throw new Error("expected response focus");
  }
}

/** A Bun.serve counter server for TUI send tests. */
export function serve(handler: (req: Request) => Response | Promise<Response>): {
  url: (path?: string) => string;
  close: () => void;
} {
  const server = Bun.serve({ port: 0, fetch: handler });
  return {
    url: (path = "/"): string => `http://127.0.0.1:${server.port}${path}`,
    close: () => server.stop(true),
  };
}

export async function teardownApps(): Promise<void> {
  for (const setup of setups.toReversed()) {
    setup.shell.dispose();
    setup.renderer.destroy();
  }
  setups.length = 0;
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
}
