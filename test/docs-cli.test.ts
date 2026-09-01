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
  dir = await mkdtemp(join(tmpdir(), "postui-docs-cli-"));
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

describe("postui docs (CLI)", () => {
  test("regenerates docs/API.md from the requests folder and exits 0", async () => {
    await saveRequestModule("users", GET_USERS);

    const code = await main(["docs"]);

    expect(code).toBe(0);
    expect(stdout()).toContain("generated docs/API.md");
    const content = await readFile(join(dir, "docs", "API.md"), "utf8");
    expect(content).toContain("- url: https://api.dev/users");
    expect(content).toContain("- method: GET");
  });

  test("--out publishes somewhere other than docs/", async () => {
    await saveRequestModule("users", GET_USERS);

    const code = await main(["docs", "--out", "public/api"]);

    expect(code).toBe(0);
    expect(stdout()).toContain("generated public/api/API.md");
    expect(existsSync(join(dir, "public", "api", "API.md"))).toBe(true);
    expect(existsSync(join(dir, "docs"))).toBe(false);
  });

  test("an empty requests folder exits 0 with a notice and writes nothing", async () => {
    await mkdir(join(dir, "requests"), { recursive: true });

    const code = await main(["docs"]);

    expect(code).toBe(0);
    expect(stderr()).toContain("no saved requests found");
    expect(stdout()).toEqual("");
    expect(existsSync(join(dir, "docs"))).toBe(false);
  });

  test("a malformed saved module exits 2 and leaves the prior document intact", async () => {
    await saveRequestModule("users", GET_USERS);
    expect(await main(["docs"])).toBe(0);
    const before = await readFile(join(dir, "docs", "API.md"), "utf8");

    await writeFile(join(dir, "requests", "zbroken.ts"), "this is not typescript(((");
    const code = await main(["docs"]);

    expect(code).toBe(2);
    expect(stderr()).toContain("zbroken.ts does not load");
    expect(await readFile(join(dir, "docs", "API.md"), "utf8")).toBe(before);
    const leftovers = (await readdir(join(dir, "docs"))).filter(f => f !== "API.md");
    expect(leftovers).toEqual([]);
  });

  test("a saved request is byte-for-byte unchanged by a docs run", async () => {
    await saveRequestModule("users", GET_USERS);
    const before = await readFile(join(dir, "requests", "users.ts"), "utf8");

    expect(await main(["docs"])).toBe(0);

    expect(await readFile(join(dir, "requests", "users.ts"), "utf8")).toBe(before);
  });

  test("--out inside the requests folder exits 2 and writes nothing there", async () => {
    await saveRequestModule("users", GET_USERS);

    const code = await main(["docs", "--out", "requests"]);

    expect(code).toBe(2);
    expect(stderr()).toContain("error:");
    expect(stderr()).toContain("requests");
    expect((await readdir(join(dir, "requests"))).toSorted()).toEqual(["users.ts"]);
  });

  test("argument errors exit 2 with usage: bare or empty --out, stray positional, unknown flag", async () => {
    await saveRequestModule("users", GET_USERS);

    expect(await main(["docs", "--out"])).toBe(2);
    expect(stderr()).toContain("Usage:");

    expect(await main(["docs", "--out", ""])).toBe(2);
    expect(stderr()).toContain("Usage:");

    expect(await main(["docs", "stray"])).toBe(2);
    expect(stderr()).toContain("Usage:");

    expect(await main(["docs", "--json"])).toBe(2);
    expect(stderr()).toContain("Usage:");
    expect(existsSync(join(dir, "docs"))).toBe(false);
  });
});
