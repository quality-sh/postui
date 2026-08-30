import { describe, expect, test, afterEach } from "bun:test";
import { saveRequest, SaveCollisionError } from "../src/save/save.ts";
import { CurlParseError } from "../src/curl/parse.ts";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

let dir: string;

afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
});

async function freshDir(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "postui-save-"));
  return dir;
}

/** Full byte snapshot of every file in the folder. */
async function snapshot(path: string): Promise<Array<[string, string]>> {
  const names = (await readdir(path)).toSorted();
  return await Promise.all(
    names.map(async n => [n, (await readFile(join(path, n))).toString()] as [string, string]),
  );
}

describe("saveRequest", () => {
  test("writes exactly one module and no auxiliary storage", async () => {
    const target = await freshDir();
    const result = await saveRequest("curl -X POST https://api.dev/users", {
      dir: target,
      name: "users",
    });
    expect(result.path).toBe(join(target, "users.ts"));
    expect(await readdir(target)).toEqual(["users.ts"]);
    expect(await readFile(join(target, "users.ts"), "utf8")).toBe(result.content);
    expect(result.content).toContain("export const request");
  });

  test("derives the name from the URL when --name is absent", async () => {
    const target = await freshDir();
    const result = await saveRequest("curl https://api.dev/orders", { dir: target });
    expect(result.path).toBe(join(target, "orders.ts"));
    expect(await readdir(target)).toEqual(["orders.ts"]);
  });

  test("rejects an invalid --name without touching the folder", async () => {
    const target = await freshDir();
    await saveRequest("curl https://api.dev/users", { dir: target, name: "users" });
    const before = await snapshot(target);
    await expect(
      saveRequest("curl https://api.dev/users", { dir: target, name: "../evil" }),
    ).rejects.toThrow(/invalid module name/);
    expect(await snapshot(target)).toEqual(before);
  });

  test("refuses to replace an existing module without force", async () => {
    const target = await freshDir();
    const first = await saveRequest("curl https://api.dev/users", {
      dir: target,
      name: "users",
    });
    try {
      await saveRequest("curl https://api.dev/other", { dir: target, name: "users" });
      expect.unreachable();
    } catch (e) {
      expect(e instanceof SaveCollisionError).toBe(true);
      if (e instanceof SaveCollisionError) expect(e.message).toContain("--force");
    }
    expect(await readFile(join(target, "users.ts"), "utf8")).toBe(first.content);
  });

  test("replaces an existing module when force is set", async () => {
    const target = await freshDir();
    await saveRequest("curl https://api.dev/users", { dir: target, name: "users" });
    const second = await saveRequest("curl -X PATCH https://api.dev/other", {
      dir: target,
      name: "users",
      force: true,
    });
    expect(await readFile(join(target, "users.ts"), "utf8")).toBe(second.content);
    expect(second.content).toContain('"PATCH"');
  });

  test("a parse failure leaves the folder byte-for-byte unchanged", async () => {
    const target = await freshDir();
    await saveRequest("curl https://api.dev/users", { dir: target, name: "users" });
    const before = await snapshot(target);
    try {
      await saveRequest("curl --wat https://api.dev/users", { dir: target });
      expect.unreachable();
    } catch (e) {
      expect(e instanceof CurlParseError).toBe(true);
    }
    expect(await snapshot(target)).toEqual(before);
  });

  test("a parse failure creates no requests folder when none exists", async () => {
    const parent = await freshDir();
    const target = join(parent, "requests");
    try {
      await saveRequest("curl -X", { dir: target });
      expect.unreachable();
    } catch (e) {
      expect(e instanceof CurlParseError).toBe(true);
    }
    expect(existsSync(target)).toBe(false);
  });

  test("persists the environment name, never the credential value", async () => {
    const target = await freshDir();
    const previous = process.env.POSTUI_TEST_TOKEN;
    process.env.POSTUI_TEST_TOKEN = "save-secret-7f3c";
    try {
      const result = await saveRequest(
        `curl -X POST https://api.dev/users -H 'Authorization: Bearer $POSTUI_TEST_TOKEN'`,
        { dir: target },
      );
      expect(result.content).toContain("POSTUI_TEST_TOKEN");
      for (const [name, content] of await snapshot(target)) {
        expect(content).not.toContain("save-secret-7f3c");
        expect(name).not.toContain("save-secret-7f3c");
      }
    } finally {
      if (previous === undefined) delete process.env.POSTUI_TEST_TOKEN;
      else process.env.POSTUI_TEST_TOKEN = previous;
    }
  });

  test("drops a literal credential from the saved module", async () => {
    const target = await freshDir();
    const result = await saveRequest(
      `curl -X POST https://api.dev/users -H 'Authorization: Bearer sk-live-abc123'`,
      { dir: target },
    );
    expect(result.redacted).toEqual(["Authorization header"]);
    for (const [, content] of await snapshot(target)) {
      expect(content).not.toContain("sk-live-abc123");
    }
    expect(result.content).toContain('"Authorization": ""');
  });

  test("drops literal URL userinfo from the saved module", async () => {
    const target = await freshDir();
    const result = await saveRequest(
      `curl https://admin:s3cret@api.dev/users`,
      { dir: target },
    );
    expect(result.redacted).toEqual(["URL userinfo"]);
    for (const [, content] of await snapshot(target)) {
      expect(content).not.toContain("s3cret");
    }
    expect(result.content).toContain('url: "https://api.dev/users"');
  });

  test("a hand edit is observed by the next plain read of the folder", async () => {
    const target = await freshDir();
    await saveRequest("curl https://api.dev/users", { dir: target, name: "users" });
    const file = join(target, "users.ts");
    const edited = (await readFile(file, "utf8")).replace('"GET"', '"PUT"');
    await writeFile(file, edited, "utf8");

    // Consumers read the folder as plain files: no index, no rebuild step.
    const reread = await readFile(file, "utf8");
    expect(reread).toBe(edited);
    const mod = await import(pathToFileURL(file).href);
    expect((mod.request as { method: string }).method).toBe("PUT");
  });

  test("report carries parse warnings for the caller to print", async () => {
    const target = await freshDir();
    const result = await saveRequest("curl -L https://api.dev/users", { dir: target });
    expect(result.warnings.map(w => w.flag)).toEqual(["-L"]);
  });
});
