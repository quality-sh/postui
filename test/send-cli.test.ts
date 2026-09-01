import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import { main } from "../src/cli.ts";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { REDACTED } from "../src/send/redact.ts";

// In-process CLI tests: exit codes and stream content through console spies.
// FD-level guarantees (true stream separation, one-shot stdin) are proven in
// test/send-process.test.ts with real child processes.

const CANARY = "agent-secret-91af";

let dir: string;
let cwd: string;
let log: ReturnType<typeof spyOn>;
let err: ReturnType<typeof spyOn>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "postui-send-cli-"));
  cwd = process.cwd();
  process.chdir(dir);
  log = spyOn(console, "log").mockImplementation(() => {});
  err = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  process.chdir(cwd);
  delete process.env.POSTUI_TEST_TOKEN;
  delete process.env.POSTUI_TOKEN_A;
  delete process.env.POSTUI_TOKEN_B;
  log.mockRestore();
  err.mockRestore();
  await rm(dir, { recursive: true, force: true });
});

function serve(handler: (req: Request) => Response) {
  const server = Bun.serve({ port: 0, fetch: handler });
  return { url: (path = "/"): string => `http://127.0.0.1:${server.port}${path}`, close: () => server.stop(true) };
}

const stdout = (): string => log.mock.calls.map((a: unknown[]) => a.join(" ")).join("\n");
const stderr = (): string => err.mock.calls.map((a: unknown[]) => a.join(" ")).join("\n");

/** A request that sends the canary via Authorization; the API echoes it back. */
async function hookEchoServer(): Promise<ReturnType<typeof serve>> {
  const server = serve(req =>
    new Response(JSON.stringify({ echoedAuth: req.headers.get("authorization") }), { status: 200 }),
  );
  await mkdir(join(dir, "requests"), { recursive: true });
  await writeFile(
    join(dir, "requests", "hooked.ts"),
    `export const request = ${JSON.stringify({
      method: "GET",
      url: server.url("/"),
      headers: { authorization: "Bearer $POSTUI_TEST_TOKEN" },
      body: null,
    })};\n`,
  );
  return server;
}

describe("postui send (CLI)", () => {
  test("a successful send exits 0, digest on stdout, stderr clean", async () => {
    const server = await hookEchoServer();
    process.env.POSTUI_TEST_TOKEN = CANARY;
    const code = await main(["send", "hooked"]);
    expect(code).toBe(0);
    expect(stdout()).toContain("-> 200");
    expect(stdout()).toContain(REDACTED);
    expect(stderr()).toBe("");
    expect(stdout() + stderr()).not.toContain(CANARY);
    server.close();
  });

  test("--json prints exactly one parseable JSON value on stdout", async () => {
    const server = await hookEchoServer();
    process.env.POSTUI_TEST_TOKEN = CANARY;
    const code = await main(["send", "hooked", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout());
    expect(parsed.request.method).toBe("GET");
    expect(parsed.response.status).toBe(200);
    expect(parsed.response.excerpt).toContain(REDACTED);
    expect(stderr()).toBe("");
    expect(stdout() + stderr()).not.toContain(CANARY);
    server.close();
  });

  test("an API rejection exits 1: digest on stdout, only the named error on stderr", async () => {
    const server = serve(() => new Response('{"message":"bad token"}', { status: 401 }));
    await mkdir(join(dir, "requests"), { recursive: true });
    await writeFile(
      join(dir, "requests", "users.ts"),
      `export const request = ${JSON.stringify({
        method: "GET",
        url: server.url("/"),
        headers: { authorization: "Bearer $POSTUI_TEST_TOKEN" },
        body: null,
      })};\n`,
    );
    process.env.POSTUI_TEST_TOKEN = CANARY;
    const code = await main(["send", "users"]);
    expect(code).toBe(1);
    expect(stdout()).toContain("-> 401");
    expect(stderr()).toBe("error: SendRejectedError: API rejected the send with status 401");
    expect(stdout() + stderr()).not.toContain(CANARY);
    server.close();
  });

  test("a rejection in --json mode keeps stdout parseable and stderr named", async () => {
    const server = serve(() => new Response('{"message":"bad token"}', { status: 403 }));
    await mkdir(join(dir, "requests"), { recursive: true });
    await writeFile(
      join(dir, "requests", "users.ts"),
      `export const request = ${JSON.stringify({
        method: "GET",
        url: server.url("/"),
        headers: { authorization: "Bearer $POSTUI_TEST_TOKEN" },
        body: null,
      })};\n`,
    );
    process.env.POSTUI_TEST_TOKEN = CANARY;
    const code = await main(["send", "users", "--json"]);
    expect(code).toBe(1);
    expect(JSON.parse(stdout()).response.status).toBe(403);
    expect(stderr()).toBe("error: SendRejectedError: API rejected the send with status 403");
    expect(stdout() + stderr()).not.toContain(CANARY);
    server.close();
  });

  test("missing env exits 2 with zero requests sent and both names listed", async () => {
    const server = serve(() => new Response("never", { status: 200 }));
    await mkdir(join(dir, "requests"), { recursive: true });
    await writeFile(
      join(dir, "requests", "guarded.ts"),
      `export const request = ${JSON.stringify({
        method: "GET",
        url: server.url("/guarded"),
        headers: { authorization: "Bearer $POSTUI_TOKEN_A", "x-key": "$POSTUI_TOKEN_B" },
        body: null,
      })};\n`,
    );
    const code = await main(["send", "guarded", "--json"]);
    expect(code).toBe(2);
    expect(stdout()).toBe("");
    expect(stderr()).toContain("error: MissingEnvError:");
    expect(stderr()).toContain("POSTUI_TOKEN_A");
    expect(stderr()).toContain("POSTUI_TOKEN_B");
    server.close();
  });

  test("an unknown request exits 2 with a named error and nothing on stdout", async () => {
    const code = await main(["send", "ghost"]);
    expect(code).toBe(2);
    expect(stdout()).toBe("");
    expect(stderr()).toContain("error: UnknownRequestError:");
  });

  test("a broken saved module exits 2 with the module error named", async () => {
    await mkdir(join(dir, "requests"), { recursive: true });
    await writeFile(join(dir, "requests", "bad.ts"), "export const request = {;\n");
    const code = await main(["send", "bad"]);
    expect(code).toBe(2);
    expect(stderr()).toContain("error: SavedModuleError:");
    expect(stdout()).toBe("");
  });

  test("a credential-shaped argument is refused with a named error", async () => {
    process.env.POSTUI_TEST_TOKEN = CANARY;
    const code = await main(["send", "hooked", "--token", CANARY]);
    expect(code).toBe(2);
    expect(stdout()).toBe("");
    expect(stderr()).toContain("error: UnknownSendFlagError:");
    expect(stderr()).toContain("cannot be passed as arguments");
  });

  test("a malformed --body-bytes value is refused", async () => {
    expect(await main(["send", "hooked", "--body-bytes", "-5"])).toBe(2);
    expect(await main(["send", "hooked", "--body-bytes", "lots"])).toBe(2);
    expect(stderr()).toContain("error: UnknownSendFlagError:");
  });

  test("no accepted option turns redaction off — wide window and json still scrub", async () => {
    const server = await hookEchoServer();
    process.env.POSTUI_TEST_TOKEN = CANARY;
    const code = await main(["send", "hooked", "--json", "--body-bytes", "1048576"]);
    expect(code).toBe(0);
    expect(stdout() + stderr()).not.toContain(CANARY);
    expect(stdout()).toContain(REDACTED);
    server.close();
  });

  test("a purported bypass flag is rejected outright", async () => {
    process.env.POSTUI_TEST_TOKEN = CANARY;
    const codes = [
      await main(["send", "hooked", "--no-redaction"]),
      await main(["send", "hooked", "--raw"]),
      await main(["send", "hooked", "--unsafe"]),
    ];
    expect(codes).toEqual([2, 2, 2]);
    expect(stdout()).toBe("");
    expect(stderr().split("error: UnknownSendFlagError:").length - 1).toBe(3);
  });

  test("a redirect warning is a diagnostic on stderr, never stdout", async () => {
    const final = serve(() => new Response("ok", { status: 200 }));
    const moved = serve(() => Response.redirect(final.url("/final"), 302));
    await mkdir(join(dir, "requests"), { recursive: true });
    await writeFile(
      join(dir, "requests", "moved.ts"),
      `export const request = ${JSON.stringify({ method: "GET", url: moved.url("/old"), headers: {}, body: null })};\n`,
    );
    const code = await main(["send", "moved", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout()).response.status).toBe(200);
    expect(stderr()).toContain("warning: followed redirect");
    final.close();
    moved.close();
  });

  test("send with no name prints usage and exits 2", async () => {
    expect(await main(["send"])).toBe(2);
    expect(stderr()).toContain("Usage:");
    expect(stdout()).toBe("");
  });
});
