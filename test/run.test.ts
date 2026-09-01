import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import { main } from "../src/cli.ts";
import { runTestCommand, NoTestCommandError } from "../src/run/exec.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;
let cwd: string;
let log: ReturnType<typeof spyOn>;
let err: ReturnType<typeof spyOn>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "postui-run-"));
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

async function writePackageJson(scripts: Record<string, string> | null, raw?: string): Promise<void> {
  if (raw !== undefined) {
    await writeFile(join(dir, "package.json"), raw);
    return;
  }
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "proj", scripts }));
}

function stdout(): string {
  return log.mock.calls.map((args: unknown[]) => args.join(" ")).join("\n");
}

function stderr(): string {
  return err.mock.calls.map((args: unknown[]) => args.join(" ")).join("\n");
}

describe("runTestCommand (execution face)", () => {
  test("exits with the child command's nonzero exit status", async () => {
    await writePackageJson({ test: "node -e 'process.exit(5)'" });
    expect(await runTestCommand()).toBe(5);
  });

  test("a passing command exits 0", async () => {
    await writePackageJson({ test: "true" });
    expect(await runTestCommand()).toBe(0);
  });

  test("no package.json is a named error", async () => {
    let thrown: unknown;
    try {
      await runTestCommand();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(NoTestCommandError);
    expect((thrown as NoTestCommandError)._tag).toBe("NoTestCommandError");
    expect((thrown as NoTestCommandError).message).toContain("scripts.test");
  });

  test("a package.json without a test script is a named error", async () => {
    await writePackageJson({ build: "tsc" });
    await expect(runTestCommand()).rejects.toBeInstanceOf(NoTestCommandError);
  });

  test("an empty test script is a named error", async () => {
    await writePackageJson({ test: "   " });
    await expect(runTestCommand()).rejects.toBeInstanceOf(NoTestCommandError);
  });

  test("an unparseable package.json is a named error", async () => {
    await writePackageJson(null, "{ not json");
    await expect(runTestCommand()).rejects.toBeInstanceOf(NoTestCommandError);
  });
});

describe("postui run (CLI)", () => {
  test("propagates the child exit status through main", async () => {
    await writePackageJson({ test: "node -e 'process.exit(7)'" });
    expect(await main(["run"])).toBe(7);
    expect(stderr()).toBe("");
  });

  test("a project with no test command exits 2 with the named error", async () => {
    await writePackageJson({});
    expect(await main(["run"])).toBe(2);
    expect(stderr()).toContain("error:");
    expect(stderr()).toContain("no test command");
    expect(stdout()).toBe("");
  });

  test("run takes no arguments — anything else is usage, exit 2", async () => {
    expect(await main(["run", "--json"])).toBe(2);
    expect(stderr()).toContain("Usage:");
  });
});

describe("postui run (spawned process, end to end)", () => {
  test("the child's stdout streams through and its exit status is postui's", async () => {
    await writePackageJson({ test: "printf runner-output; exit 3" });
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "run"],
      {
        cwd: dir,
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(code).toBe(3);
    expect(out).toContain("runner-output");
  });

  test("a project with no test command exits 2 in a real process too", async () => {
    await writePackageJson({});
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "run"],
      {
        cwd: dir,
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, , errText] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(2);
    expect(errText).toContain("defines no test command");
  });
});
