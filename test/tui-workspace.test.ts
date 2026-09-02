import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SavedModuleError } from "../src/gen/load.ts";
import { WorkspaceReadError, readWorkspace } from "../src/tui/workspace.ts";

const dirs: string[] = [];

async function makeRequestsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "postui-workspace-test-"));
  dirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(
    dirs.map(dir => rm(dir, { recursive: true, force: true })),
  );
});

function moduleSource(method: string, url: string): string {
  return `export const request = { method: "${method}", url: "${url}", headers: {}, body: null };\n`;
}

describe("readWorkspace", () => {
  test("lists every saved request through the shared loader", async () => {
    const dir = await makeRequestsDir();
    await writeFile(join(dir, "create.ts"), moduleSource("POST", "https://api.dev/users"));
    await writeFile(join(dir, "health.ts"), moduleSource("GET", "https://api.dev/health"));
    const requests = await readWorkspace(dir);
    expect(requests.map(request => request.name).toSorted()).toEqual(["create", "health"]);
    expect(requests[0]?.path.startsWith(dir)).toBe(true);
  });

  test("a hand edit to a module is visible on the next read (no restart)", async () => {
    const dir = await makeRequestsDir();
    const file = join(dir, "edit.ts");
    await writeFile(file, moduleSource("POST", "https://api.dev/users"));
    expect((await readWorkspace(dir))[0]?.request.method).toBe("POST");
    await writeFile(file, moduleSource("GET", "https://api.dev/users"));
    const requests = await readWorkspace(dir);
    expect(requests[0]?.request.method).toBe("GET");
  });

  test("a deleted module disappears on the next read", async () => {
    const dir = await makeRequestsDir();
    const file = join(dir, "gone.ts");
    await writeFile(file, moduleSource("GET", "https://api.dev/health"));
    expect((await readWorkspace(dir)).length).toBe(1);
    await rm(file);
    expect(await readWorkspace(dir)).toEqual([]);
  });

  test("a missing requests folder reads as empty, like the loader", async () => {
    expect(await readWorkspace(join(tmpdir(), "postui-missing-" + Date.now()))).toEqual([]);
  });

  test("a malformed module surfaces the loader's named error against the real folder", async () => {
    const dir = await makeRequestsDir();
    await writeFile(join(dir, "broken.ts"), "export const request = {");
    try {
      await readWorkspace(dir);
      throw new Error("expected readWorkspace to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(SavedModuleError);
      const message = (error as SavedModuleError).message;
      expect(message).toContain(join(dir, "broken.ts"));
      expect(message).toContain("does not load");
      expect(message).not.toContain("postui-requests-");
    }
  });

  test("a module without a request export surfaces SavedModuleError too", async () => {
    const dir = await makeRequestsDir();
    await writeFile(join(dir, "empty.ts"), "export const nothing = 1;\n");
    try {
      await readWorkspace(dir);
      throw new Error("expected readWorkspace to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(SavedModuleError);
      expect((error as SavedModuleError).message).toContain("does not export a request");
    }
  });

  test("an unreadable requests folder surfaces WorkspaceReadError", async () => {
    // a .ts path is not a directory: readdir fails with ENOTDIR, not ENOENT
    try {
      await readWorkspace("/dev/null");
      throw new Error("expected readWorkspace to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceReadError);
      expect((error as WorkspaceReadError).message).toContain("cannot read requests folder");
    }
  });
});
