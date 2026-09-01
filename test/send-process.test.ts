import { describe, expect, test, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// These tests run postui as a real child process so assertions hold at the
// file-descriptor boundary: stream separation, exit statuses, and one-shot
// stdin behavior cannot be proven through console spies.

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const CANARY = "agent-secret-91af";

interface Observer {
  port: number;
  readonly connections: number;
  readonly requests: number;
  close(): void;
}

/** Raw TCP observer that never responds; counts connections and request lines. */
function observingServer(): Observer {
  let connections = 0;
  let requests = 0;
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open() {
        connections++;
      },
      data(_socket, chunk: Uint8Array) {
        requests += Buffer.from(chunk).toString("latin1").split("HTTP/1").length - 1;
      },
    },
  });
  return {
    port: server.port,
    get connections() {
      return connections;
    },
    get requests() {
      return requests;
    },
    close: () => server.stop(true),
  };
}

function serve(handler: (req: Request) => Response) {
  const server = Bun.serve({ port: 0, fetch: handler });
  return { url: (path = "/"): string => `http://127.0.0.1:${server.port}${path}`, close: () => server.stop(true) };
}

const disposables: Array<{ close(): void }> = [];
const dirs: string[] = [];

afterEach(async () => {
  while (disposables.length > 0) disposables.pop()?.close();
  const pending = dirs.map(d => rm(d, { recursive: true, force: true }));
  dirs.length = 0;
  await Promise.all(pending);
});

/** Run the real CLI in dir; overrides are the only POSTUI_* names the child sees. */
function runSend(
  dir: string,
  args: string[],
  envOverrides: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("POSTUI_")) env[k] = v;
  }
  for (const [k, v] of Object.entries(envOverrides)) env[k] = v;
  const proc = Bun.spawn([process.execPath, CLI, "send", ...args], {
    cwd: dir,
    env,
    stdin: "ignore", // one-shot: no user input exists to read
    stdout: "pipe",
    stderr: "pipe",
  });
  return Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).then(([code, stdout, stderr]) => ({ code, stdout, stderr }));
}

async function makeWorkspace(url: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "postui-send-proc-"));
  dirs.push(dir);
  await mkdir(join(dir, "requests"), { recursive: true });
  await writeFile(
    join(dir, "requests", "hooked.ts"),
    `export const request = ${JSON.stringify({
      method: "GET",
      url,
      headers: {
        authorization: "Bearer $POSTUI_TEST_TOKEN",
        "x-api-key": "$POSTUI_TEST_TOKEN",
      },
      body: null,
    })};\n`,
  );
  return dir;
}

/** An API that echoes the credential values back in body and response header. */
function echoingServer(): ReturnType<typeof serve> {
  const server = serve(req =>
    new Response(
      JSON.stringify({
        echoedAuth: req.headers.get("authorization"),
        echoedKey: req.headers.get("x-api-key"),
      }),
      { status: 200, headers: { "x-trace-auth": req.headers.get("authorization") ?? "" } },
    ),
  );
  disposables.push(server);
  return server;
}

describe("postui send (spawned process)", () => {
  test("one shot: stdin ignored, exits 0, digest on stdout, stderr silent, no canary anywhere", async () => {
    const api = echoingServer();
    const dir = await makeWorkspace(api.url("/"));
    const r = await runSend(dir, ["hooked"], { POSTUI_TEST_TOKEN: CANARY });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("-> 200");
    expect(r.stdout).toContain("[redacted]");
    expect(r.stderr).toBe("");
    expect(r.stdout + r.stderr).not.toContain(CANARY);
  });

  test("API rejection exits 1 and names the typed error on stderr", async () => {
    const api = serve(() => new Response('{"error":"denied"}', { status: 401 }));
    disposables.push(api);
    const dir = await makeWorkspace(api.url("/"));
    const r = await runSend(dir, ["hooked"], { POSTUI_TEST_TOKEN: CANARY });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("-> 401");
    expect(r.stderr).toContain("error: SendRejectedError:");
    expect(r.stdout + r.stderr).not.toContain(CANARY);
  });

  test("missing token exits 2 with zero connections to the observing server", async () => {
    const observer = observingServer();
    disposables.push(observer);
    const dir = await makeWorkspace(`http://127.0.0.1:${observer.port}/hooked`);
    const r = await runSend(dir, ["hooked"]); // token deliberately unset
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("error: MissingEnvError:");
    expect(observer.connections).toBe(0);
    expect(observer.requests).toBe(0);
  });

  test("--json stdout is exactly one JSON value; stderr stays empty", async () => {
    const api = echoingServer();
    const dir = await makeWorkspace(api.url("/"));
    const r = await runSend(dir, ["hooked", "--json"], { POSTUI_TEST_TOKEN: CANARY });
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout); // throws if stdout holds anything but the one value
    expect(parsed.request.method).toBe("GET");
    expect(parsed.response.status).toBe(200);
    expect(r.stderr).toBe("");
    expect(r.stdout + r.stderr).not.toContain(CANARY);
  });

  test("no accepted flag combination reveals the canary; bypass flags are refused", async () => {
    const api = echoingServer();
    const dir = await makeWorkspace(api.url("/"));
    const wide = await runSend(dir, ["hooked", "--json", "--body-bytes", "1048576"], {
      POSTUI_TEST_TOKEN: CANARY,
    });
    expect(wide.code).toBe(0);
    expect(wide.stdout + wide.stderr).not.toContain(CANARY);
    expect(wide.stdout).toContain("[redacted]");

    const bypass = await runSend(dir, ["hooked", "--no-redaction"], {
      POSTUI_TEST_TOKEN: CANARY,
    });
    expect(bypass.code).toBe(2);
    expect(bypass.stdout).toBe("");
    expect(bypass.stderr).toContain("error: UnknownSendFlagError:");
    expect(bypass.stdout + bypass.stderr).not.toContain(CANARY);
  });

  test("credential-shaped arguments are refused before any network I/O", async () => {
    const observer = observingServer();
    disposables.push(observer);
    const dir = await makeWorkspace(`http://127.0.0.1:${observer.port}/`);
    const r = await runSend(dir, ["hooked", "--token", CANARY], { POSTUI_TEST_TOKEN: CANARY });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("error: UnknownSendFlagError:");
    expect(observer.requests).toBe(0);
  });
});
