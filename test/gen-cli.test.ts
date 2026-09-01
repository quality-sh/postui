import { describe, expect, test, afterEach, beforeEach, spyOn } from "bun:test";
import { main } from "../src/cli.ts";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;
let cwd: string;
let log: ReturnType<typeof spyOn>;
let err: ReturnType<typeof spyOn>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "postui-gen-cli-"));
  cwd = process.cwd();
  process.chdir(dir);
  log = spyOn(console, "log").mockImplementation(() => {});
  err = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  process.chdir(cwd);
  log.mockRestore();
  err.mockRestore();
  await rm(dir, { recursive: true, force: true });
});

function stdout(): string {
  return log.mock.calls.map((args: unknown[]) => args.join(" ")).join("\n");
}

function stderr(): string {
  return err.mock.calls.map((args: unknown[]) => args.join(" ")).join("\n");
}

async function writePackageJson(deps: Record<string, string>): Promise<void> {
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "proj", devDependencies: deps }));
}

/** A saved module in the exact shape `postui save` emits. */
async function saveRequestModule(name: string, spec: Record<string, unknown>): Promise<void> {
  await mkdir(join(dir, "requests"), { recursive: true });
  await writeFile(
    join(dir, "requests", `${name}.ts`),
    `// Saved by postui — this file is the request; edit it freely.\n` +
      `export const request = ${JSON.stringify(spec, null, 2)};\n`,
  );
}

const GET_USERS = { method: "GET", url: "https://api.dev/users", headers: {}, body: null };

describe("postui gen (CLI)", () => {
  test("generates from the detected framework and exits 0", async () => {
    await writePackageJson({ vitest: "^3.0.0" });
    await saveRequestModule("users", GET_USERS);

    const code = await main(["gen"]);

    expect(code).toBe(0);
    expect(stdout()).toContain("generated tests/users.test.ts");
    const content = await readFile(join(dir, "tests", "users.test.ts"), "utf8");
    expect(content).toContain('from "vitest"');
    expect(content).toContain('from "../requests/users.ts"');
  });

  test("an explicit flag overrides the detected framework", async () => {
    await writePackageJson({ vitest: "^3.0.0" });
    await saveRequestModule("users", GET_USERS);

    const code = await main(["gen", "--framework", "node:test"]);

    expect(code).toBe(0);
    const content = await readFile(join(dir, "tests", "users.test.ts"), "utf8");
    expect(content).toContain('from "node:test"');
    expect(content).toContain("node:assert/strict");
    expect(content).not.toContain('from "vitest"');
    expect(existsSync(join(dir, "tests"))).toBe(true);
    const generated = await readdir(join(dir, "tests"));
    expect(generated).toEqual(["users.test.ts"]);
  });

  test("jest is refused with the named error and no destination is created", async () => {
    await writePackageJson({ vitest: "^3.0.0" });
    await saveRequestModule("users", GET_USERS);

    const code = await main(["gen", "--framework", "jest"]);

    expect(code).toBe(2);
    expect(stderr()).toContain("error:");
    expect(stderr()).toContain("Jest is deliberately unsupported");
    expect(existsSync(join(dir, "tests"))).toBe(false);
  });

  test("an unknown target exits 2 with the named error", async () => {
    await saveRequestModule("users", GET_USERS);

    const code = await main(["gen", "--framework", "mocha"]);

    expect(code).toBe(2);
    expect(stderr()).toContain('unknown test target "mocha"');
    expect(existsSync(join(dir, "tests"))).toBe(false);
  });

  test("no detectable framework exits 2, writes no replacement", async () => {
    await writePackageJson({ vitest: "^3.0.0" });
    await saveRequestModule("users", GET_USERS);
    expect(await main(["gen"])).toBe(0);
    const generated = await readFile(join(dir, "tests", "users.test.ts"), "utf8");

    // The project stops declaring a supported framework; regen refuses.
    await writePackageJson({ jest: "^29.0.0" });
    const code = await main(["gen"]);

    expect(code).toBe(2);
    expect(stderr()).toContain("no supported test framework");
    expect(await readFile(join(dir, "tests", "users.test.ts"), "utf8")).toBe(generated);
  });

  test("a missing package.json exits 2", async () => {
    await saveRequestModule("users", GET_USERS);

    const code = await main(["gen"]);

    expect(code).toBe(2);
    expect(stderr()).toContain("no package.json found");
  });

  test("an empty requests folder exits 0 with a notice and writes nothing", async () => {
    await writePackageJson({ vitest: "^3.0.0" });
    await mkdir(join(dir, "requests"), { recursive: true });

    const code = await main(["gen"]);

    expect(code).toBe(0);
    expect(stderr()).toContain("no saved requests found");
    expect(stdout()).toEqual("");
    expect(existsSync(join(dir, "tests"))).toBe(false);
  });

  test("a missing requests folder exits 0 with a notice and writes nothing", async () => {
    await writePackageJson({ vitest: "^3.0.0" });

    const code = await main(["gen"]);

    expect(code).toBe(0);
    expect(stderr()).toContain("no saved requests found");
  });

  test("a malformed saved module exits 2 and writes nothing", async () => {
    await writePackageJson({ vitest: "^3.0.0" });
    await saveRequestModule("users", GET_USERS);
    await writeFile(join(dir, "requests", "broken.ts"), "export const request = {{{;");

    const code = await main(["gen"]);

    expect(code).toBe(2);
    expect(stderr()).toContain("broken.ts does not load");
    expect(existsSync(join(dir, "tests"))).toBe(false);
  });

  test("a module without a request export exits 2", async () => {
    await writePackageJson({ vitest: "^3.0.0" });
    await mkdir(join(dir, "requests"), { recursive: true });
    await writeFile(join(dir, "requests", "helper.ts"), "export const helper = 1;\n");

    const code = await main(["gen"]);

    expect(code).toBe(2);
    expect(stderr()).toContain("does not export a request");
  });

  test("a request with a non-string method exits 2", async () => {
    await writePackageJson({ vitest: "^3.0.0" });
    await saveRequestModule("users", { ...GET_USERS, method: 42 });

    const code = await main(["gen"]);

    expect(code).toBe(2);
    expect(stderr()).toContain("request.method must be a string");
  });

  test("a failed run leaves a prior destination byte-for-byte unchanged", async () => {
    await writePackageJson({ vitest: "^3.0.0" });
    await saveRequestModule("users", GET_USERS);
    expect(await main(["gen"])).toBe(0);
    const before = await readFile(join(dir, "tests", "users.test.ts"), "utf8");

    // A later module breaks; emission stops before anything is written.
    await writeFile(join(dir, "requests", "zbroken.ts"), "this is not typescript(((");
    const code = await main(["gen"]);

    expect(code).toBe(2);
    expect(stderr()).toContain("zbroken.ts does not load");
    expect(await readFile(join(dir, "tests", "users.test.ts"), "utf8")).toBe(before);
    const leftovers = (await readdir(join(dir, "tests"))).filter(f => f !== "users.test.ts");
    expect(leftovers).toEqual([]);
  });

  test("regeneration replaces postui-generated files and shows hand edits", async () => {
    await writePackageJson({ vitest: "^3.0.0" });
    await saveRequestModule("users", GET_USERS);
    expect(await main(["gen"])).toBe(0);

    // Hand-edit the saved request, then regenerate over the generated file.
    await saveRequestModule("users", { ...GET_USERS, url: "https://api.dev/v2/users" });
    const code = await main(["gen"]);

    expect(code).toBe(0);
    const content = await readFile(join(dir, "tests", "users.test.ts"), "utf8");
    expect(content).toContain('from "../requests/users.ts"');
  });

  test("a hand-written file at a destination is never clobbered", async () => {
    await writePackageJson({ vitest: "^3.0.0" });
    await saveRequestModule("users", GET_USERS);
    await mkdir(join(dir, "tests"), { recursive: true });
    const handWritten = "describe('mine', () => { it('works', () => {}); });\n";
    await writeFile(join(dir, "tests", "users.test.ts"), handWritten);

    const code = await main(["gen"]);

    expect(code).toBe(2);
    expect(stderr()).toContain("was not generated by postui");
    expect(await readFile(join(dir, "tests", "users.test.ts"), "utf8")).toBe(handWritten);
  });

  test("a request named like a test file still lands at a distinct destination", async () => {
    await writePackageJson({ vitest: "^3.0.0" });
    await saveRequestModule("users.test", GET_USERS);

    const code = await main(["gen"]);

    expect(code).toBe(0);
    expect(stdout()).toContain("generated tests/users.test.test.ts");
    expect(existsSync(join(dir, "tests", "users.test.test.ts"))).toBe(true);
  });

  test("every saved request gets a file", async () => {
    await writePackageJson({ "@types/bun": "^1.3.0" });
    await saveRequestModule("users", GET_USERS);
    await saveRequestModule("orders", {
      method: "POST",
      url: "https://api.dev/orders",
      headers: { "Content-Type": "application/json" },
      body: '{"item":1}',
    });

    const code = await main(["gen"]);

    expect(code).toBe(0);
    const generated = (await readdir(join(dir, "tests"))).toSorted();
    expect(generated).toEqual(["orders.test.ts", "users.test.ts"]);
    const orders = await readFile(join(dir, "tests", "orders.test.ts"), "utf8");
    expect(orders).toContain('from "bun:test"');
  });

  test("gen flags are validated: a stray positional and a bare --framework exit 2", async () => {
    expect(await main(["gen", "stray"])).toBe(2);
    expect(stderr()).toContain("Usage:");
    expect(await main(["gen", "--framework"])).toBe(2);
    expect(stderr()).toContain("Usage:");
  });
});

describe("postui gen — emitted tests run standalone", () => {
  test("a generated bun:test file hits the API and resolves $ENV at test time", async () => {
    // Async spawn, not spawnSync: the child fetches THIS process's server,
    // so the parent event loop must stay free while the child runs.
    const seen: Array<string | null> = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push(req.headers.get("authorization"));
        return new Response("ok");
      },
    });
    try {
      await writePackageJson({ "@types/bun": "^1.3.0" });
      await saveRequestModule("ping", {
        method: "GET",
        url: `http://127.0.0.1:${server.port}/ping`,
        headers: { Authorization: "Bearer $PING_TOKEN" },
        body: null,
      });
      expect(await main(["gen"])).toBe(0);
      const testFile = join(dir, "tests", "ping.test.ts");

      // Without the token the test skips and sends nothing.
      const withoutToken = { ...process.env } as Record<string, string>;
      delete withoutToken.PING_TOKEN;
      const skipped = Bun.spawn({
        cmd: [process.execPath, "test", testFile],
        cwd: dir,
        env: withoutToken,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await skipped.exited).toBe(0);
      expect(seen).toEqual([]);

      // With the token set, the substituted request is sent.
      const ran = Bun.spawn({
        cmd: [process.execPath, "test", testFile],
        cwd: dir,
        env: { ...process.env, PING_TOKEN: "secret-value" } as Record<string, string>,
        stdout: "pipe",
        stderr: "pipe",
      });
      const ranErr = await new Response(ran.stderr).text();
      expect(await ran.exited).toBe(0);
      expect(ranErr).not.toContain("(fail)");
      expect(seen).toEqual(["Bearer secret-value"]);
      expect(ranErr).toContain("1 pass");
    } finally {
      server.stop(true);
    }
  });
});
