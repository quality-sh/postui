import { describe, expect, test } from "bun:test";
import { generateDocs, DocsOutError } from "../src/docs/docs.ts";
import { SavedModuleError } from "../src/gen/load.ts";
import { mkdtemp, writeFile, mkdir, rm, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "postui-docs-"));
}

/** A postui-emitted `export const request` module at requests/<name>.ts. */
async function save(dir: string, name: string, spec: Record<string, unknown>): Promise<void> {
  await mkdir(join(dir, "requests"), { recursive: true });
  await writeFile(
    join(dir, "requests", `${name}.ts`),
    `// Saved by postui — this file is the request; edit it freely.\n` +
      `export const request = ${JSON.stringify(spec, null, 2)};\n`,
  );
}

async function doc(root: string): Promise<string> {
  return await readFile(join(root, "docs", "API.md"), "utf8");
}

const USERS = { method: "GET", url: "https://api.dev/users", headers: {}, body: null };

describe("generateDocs — docs_folder_only", () => {
  test("documents exactly the requests found in the requests folder", async () => {
    const dir = await scratch();
    try {
      await save(dir, "users", USERS);
      await save(dir, "orders", {
        method: "POST",
        url: "https://api.dev/orders",
        headers: { "Content-Type": "application/json" },
        body: '{"item":1}',
      });
      // Outside the requests folder: never a documentation source.
      await writeFile(join(dir, "stranger.ts"), "export const request = 1;\n");

      const result = await generateDocs({ root: dir });
      expect(result.file).toBe(join("docs", "API.md"));

      const text = await doc(dir);
      expect(text).toContain("## orders");
      expect(text).toContain("## users");
      expect(text).toContain("- method: POST");
      expect(text).toContain("- url: https://api.dev/orders");
      expect(text).toContain("- url: https://api.dev/users");
      expect(text).toContain("- method: GET");
      expect(text).toContain("Content-Type: application/json");
      expect(text).toContain('{"item":1}');
      // Sections come in folder order, and nothing else gets a section.
      expect(text.indexOf("## orders")).toBeLessThan(text.indexOf("## users"));
      expect(text.match(/^## .+$/gm)).toEqual(["## orders", "## users"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("generateDocs — docs_no_annotations", () => {
  test("documents a plain saved module from the module alone", async () => {
    const dir = await scratch();
    try {
      await save(dir, "users", USERS);

      await generateDocs({ root: dir });

      const text = await doc(dir);
      expect(text).toContain("## users");
      expect(text).toContain("- method: GET");
      expect(text).toContain("- url: https://api.dev/users");
      expect(text).toContain("### headers");
      expect(text).toContain("### body");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("generateDocs — folder state on the next run", () => {
  test("a hand edit to a request is reflected by the next generation", async () => {
    const dir = await scratch();
    try {
      await save(dir, "users", USERS);
      const cli = join(import.meta.dir, "..", "src", "cli.ts");
      const run = async (): Promise<number> => {
        const proc = Bun.spawn({
          cmd: [process.execPath, cli, "docs"],
          cwd: dir,
          stdout: "pipe",
          stderr: "pipe",
        });
        await proc.exited;
        return proc.exitCode ?? 1;
      };

      expect(await run()).toBe(0);
      expect(await doc(dir)).toContain("https://api.dev/users");

      await save(dir, "users", { ...USERS, url: "https://api.dev/v2/users" });
      expect(await run()).toBe(0);

      const text = await doc(dir);
      expect(text).toContain("https://api.dev/v2/users");
      expect(text).not.toContain("https://api.dev/users");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a deleted request is absent from the next generation", async () => {
    const dir = await scratch();
    try {
      await save(dir, "users", USERS);
      await save(dir, "orders", { method: "POST", url: "https://api.dev/orders", headers: {}, body: null });
      await generateDocs({ root: dir });
      expect(await doc(dir)).toContain("## orders");

      await rm(join(dir, "requests", "orders.ts"));
      await generateDocs({ root: dir });

      const text = await doc(dir);
      expect(text).toContain("## users");
      expect(text).not.toContain("## orders");
      expect(text).not.toContain("api.dev/orders");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("generateDocs — docs_read_only + docs_no_store", () => {
  test("requests stay byte-for-byte unchanged and nothing but the document is written", async () => {
    const dir = await scratch();
    try {
      await save(dir, "users", USERS);
      await writeFile(join(dir, "requests", "notes.md"), "hand-written notes\n");
      const beforeRequests = await readFile(join(dir, "requests", "users.ts"), "utf8");
      const entriesBefore = (await readdir(dir)).toSorted();

      await generateDocs({ root: dir });

      expect(await readFile(join(dir, "requests", "users.ts"), "utf8")).toBe(beforeRequests);
      // No copied store, index, or database anywhere — the only new entry is docs/.
      expect((await readdir(dir)).toSorted()).toEqual(entriesBefore.concat("docs").toSorted());
      expect((await readdir(join(dir, "docs"))).toSorted()).toEqual(["API.md"]);
      expect(existsSync(join(dir, "requests", "notes.md"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("generateDocs — rule_gen_emit_no_partial", () => {
  test("a failed run leaves the prior document byte-for-byte unchanged with no temp leftovers", async () => {
    const dir = await scratch();
    try {
      await save(dir, "users", USERS);
      await generateDocs({ root: dir });
      const before = await doc(dir);

      await writeFile(join(dir, "requests", "zbroken.ts"), "export const request = {{{;");
      try {
        await generateDocs({ root: dir });
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(SavedModuleError);
        expect((e as SavedModuleError).message).toContain("zbroken.ts does not load");
      }

      expect(await doc(dir)).toBe(before);
      expect((await readdir(join(dir, "docs"))).toSorted()).toEqual(["API.md"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("unrelated files in the output directory are never touched", async () => {
    const dir = await scratch();
    try {
      await save(dir, "users", USERS);
      await mkdir(join(dir, "docs"), { recursive: true });
      await writeFile(join(dir, "docs", "API.md"), "stale\n");
      await writeFile(join(dir, "docs", "notes.md"), "hand-written notes\n");

      await generateDocs({ root: dir });

      expect(await doc(dir)).not.toBe("stale\n");
      expect(await readFile(join(dir, "docs", "notes.md"), "utf8")).toBe("hand-written notes\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});


describe("generateDocs — destinations", () => {
  test("an empty or missing requests folder documents nothing and creates no output", async () => {
    const empty = await scratch();
    const missing = await scratch();
    try {
      await mkdir(join(empty, "requests"), { recursive: true });

      expect(await generateDocs({ root: empty })).toEqual({ file: null });
      expect(existsSync(join(empty, "docs"))).toBe(false);

      expect(await generateDocs({ root: missing })).toEqual({ file: null });
      expect(existsSync(join(missing, "docs"))).toBe(false);
    } finally {
      await rm(empty, { recursive: true, force: true });
      await rm(missing, { recursive: true, force: true });
    }
  });

  test("--out publishes the document to the given directory", async () => {
    const dir = await scratch();
    try {
      await save(dir, "users", USERS);

      const result = await generateDocs({ root: dir, out: "public/api" });

      expect(result.file).toBe(join("public", "api", "API.md"));
      expect(existsSync(join(dir, "public", "api", "API.md"))).toBe(true);
      expect(existsSync(join(dir, "docs"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("output inside the requests folder is refused", async () => {
    const dir = await scratch();
    try {
      await save(dir, "users", USERS);

      try {
        await generateDocs({ root: dir, out: "requests" });
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(DocsOutError);
        expect((e as DocsOutError).message).toContain("requests");
      }
      try {
        await generateDocs({ root: dir, out: "requests/nested" });
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(DocsOutError);
      }

      // Nothing was written into the folder, and the document never appeared.
      expect((await readdir(join(dir, "requests"))).toSorted()).toEqual(["users.ts"]);
      expect(existsSync(join(dir, "docs"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
