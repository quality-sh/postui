import { describe, expect, test, afterEach, spyOn, beforeEach } from "bun:test";
import { main } from "../src/cli.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;
let cwd: string;
let log: ReturnType<typeof spyOn>;
let err: ReturnType<typeof spyOn>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "postui-cli-"));
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

function stdout(): string[] {
  return log.mock.calls.map((args: unknown[]) => args.join(" "));
}

function stderr(): string[] {
  return err.mock.calls.map((args: unknown[]) => args.join(" "));
}

describe("postui save (CLI)", () => {
  test("saves with an explicit name and exits 0", async () => {
    const code = await main(["save", "--name", "users", "curl -X POST https://api.dev/users"]);
    expect(code).toBe(0);
    expect(stdout()).toEqual(["saved requests/users.ts"]);
    expect(existsSync(join(dir, "requests", "users.ts"))).toBe(true);
  });

  test("derives the name from the URL end to end", async () => {
    const code = await main(["save", "curl https://api.dev/orders"]);
    expect(code).toBe(0);
    expect(stdout()).toEqual(["saved requests/orders.ts"]);
  });

  test("prints parse warnings on stderr and the result on stdout", async () => {
    const code = await main(["save", "curl -L https://api.dev/follow"]);
    expect(code).toBe(0);
    expect(stdout()).toEqual(["saved requests/follow.ts"]);
    expect(stderr().join("\n")).toContain("warning: -L ignored");
  });

  test("a parse failure exits 1, reports on stderr, and writes nothing", async () => {
    const code = await main(["save", "curl --wat https://api.dev/users"]);
    expect(code).toBe(1);
    expect(stderr().join("\n")).toContain("error:");
    expect(existsSync(join(dir, "requests"))).toBe(false);
  });

  test("a collision exits 2 and --force replaces", async () => {
    await main(["save", "--name", "users", "curl https://api.dev/users"]);
    const first = await readFile(join(dir, "requests", "users.ts"), "utf8");

    const collision = await main(["save", "--name", "users", "curl https://api.dev/other"]);
    expect(collision).toBe(2);
    expect(stderr().join("\n")).toContain("--force");
    expect(await readFile(join(dir, "requests", "users.ts"), "utf8")).toBe(first);

    const forced = await main([
      "save",
      "--name",
      "users",
      "--force",
      "curl https://api.dev/other",
    ]);
    expect(forced).toBe(0);
    expect(await readFile(join(dir, "requests", "users.ts"), "utf8")).toContain("other");
  });

  test("a bad module name exits 2", async () => {
    const code = await main(["save", "--name", "../evil", "curl https://api.dev/users"]);
    expect(code).toBe(2);
    expect(stderr().join("\n")).toContain("invalid module name");
    expect(existsSync(join(dir, "requests"))).toBe(false);
  });

  test("a credential literal warns on stderr and never lands in the file", async () => {
    const code = await main([
      "save",
      "curl -H 'Authorization: Bearer sk-live-abc123' https://api.dev/users",
    ]);
    expect(code).toBe(0);
    expect(stderr().join("\n")).toContain("Authorization");
    const content = await readFile(join(dir, "requests", "users.ts"), "utf8");
    expect(content).not.toContain("sk-live-abc123");
  });

  test("no curl input exits 2 with usage on stderr", async () => {
    const code = await main(["save"]);
    expect(code).toBe(2);
    expect(stderr().join("\n")).toContain("Usage:");
    expect(stdout()).toEqual([]);
  });

  test("--name without a value exits 2 with usage on stderr", async () => {
    const code = await main(["save", "--name"]);
    expect(code).toBe(2);
    expect(stderr().join("\n")).toContain("Usage:");
  });

  test("the inspect path still parses a curl after the save flag exists", async () => {
    const code = await main(["curl", "https://api.dev/users"]);
    expect(code).toBe(0);
    expect(stdout().join("\n")).toContain("GET");
    expect(existsSync(join(dir, "requests"))).toBe(false);
  });
});
