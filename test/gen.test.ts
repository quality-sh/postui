import { describe, expect, test } from "bun:test";
import { detectFramework, readPackageJson, FrameworkNotDetectedError } from "../src/gen/detect.ts";
import { renderTest } from "../src/gen/render.ts";
import { TEST_TARGETS } from "../src/gen/targets.ts";
import { generateTests } from "../src/gen/gen.ts";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "postui-gen-"));
}

/** A postui-emitted `export const request` module. */
function savedModule(spec: Record<string, unknown>): string {
  return `export const request = ${JSON.stringify(spec, null, 2)};\n`;
}

/** Write a package.json + requests module, then generate. */
async function project(spec: Record<string, unknown>): Promise<string> {
  const dir = await scratch();
  await mkdir(join(dir, "requests"), { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "proj", devDependencies: { "@types/node": "^22" } }),
  );
  await writeFile(join(dir, "requests", "users.ts"), savedModule(spec));
  return dir;
}

const SIMPLE = { method: "GET", url: "https://api.dev/users", headers: {}, body: null };

describe("detectFramework", () => {
  test("prefers vitest over bun and node markers", () => {
    const pkg = { devDependencies: { vitest: "^3", "@types/bun": "^1", "@types/node": "^22" } };
    expect(detectFramework(pkg)).toBe("vitest");
  });

  test("prefers bun:test over node:test markers", () => {
    const pkg = { devDependencies: { "@types/bun": "^1", "@types/node": "^22" } };
    expect(detectFramework(pkg)).toBe("bun:test");
  });

  test("detects node:test from @types/node", () => {
    expect(detectFramework({ devDependencies: { "@types/node": "^22" } })).toBe("node:test");
  });

  test("looks in dependencies too", () => {
    expect(detectFramework({ dependencies: { vitest: "^3" } })).toBe("vitest");
  });

  test("unsupported-only projects raise the named detection error", () => {
    try {
      detectFramework({ devDependencies: { jest: "^29" } });
      expect.unreachable();
    } catch (e) {
      // Instance-of on the exported TaggedError class is the named-type check.
      expect(e).toBeInstanceOf(FrameworkNotDetectedError);
      expect((e as FrameworkNotDetectedError).message).toContain("no supported test framework");
    }
  });

  test("an empty package.json raises the detection error", () => {
    expect(() => detectFramework({})).toThrow(FrameworkNotDetectedError);
    expect(() => detectFramework(null)).toThrow(FrameworkNotDetectedError);
  });
});

describe("readPackageJson", () => {
  test("a missing package.json raises the named detection error", async () => {
    const dir = await scratch();
    try {
      try {
        await readPackageJson(dir);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(FrameworkNotDetectedError);
        expect((e as FrameworkNotDetectedError).message).toContain("no package.json found");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("invalid JSON raises the named detection error", async () => {
    const dir = await scratch();
    try {
      await writeFile(join(dir, "package.json"), "{not json");
      try {
        await readPackageJson(dir);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(FrameworkNotDetectedError);
        expect((e as FrameworkNotDetectedError).message).toContain("not valid JSON");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("declared targets", () => {
  test("the targets module declares exactly vitest, bun:test, and node:test", () => {
    expect([...TEST_TARGETS]).toEqual(["vitest", "bun:test", "node:test"]);
  });

  test("explicit jest selection stops generation with the named refusal", async () => {
    const dir = await project(SIMPLE);
    try {
      try {
        await generateTests({ root: dir, framework: "jest" });
        expect.unreachable();
      } catch (e) {
        expect((e as Error).message).toContain("Jest is deliberately unsupported");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an unknown explicit target stops generation with the named error", async () => {
    const dir = await project(SIMPLE);
    try {
      try {
        await generateTests({ root: dir, framework: "mocha" });
        expect.unreachable();
      } catch (e) {
        expect((e as Error).message).toContain('unknown test target "mocha"');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an explicit supported target overrides detection", async () => {
    const dir = await project(SIMPLE);
    try {
      const result = await generateTests({ root: dir, framework: "bun:test" });
      expect(result.target).toBe("bun:test");
      const content = await Bun.file(join(dir, "tests", "users.test.ts")).text();
      expect(content).toContain('from "bun:test"');
      expect(content).not.toContain('from "vitest"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function importsOf(source: string): string[] {
  return [...source.matchAll(/from "([^"]+)"/g)].map(m => m[1] ?? "");
}

describe("renderTest — raw framework-native emission", () => {
  const opts = { name: "users", importPath: "../requests/users.ts" };

  for (const target of TEST_TARGETS) {
    test(`${target}: parses as TypeScript and imports no postui code`, () => {
      const source = renderTest(target, opts);
      // Transpiles standalone — valid TS without any postui context.
      expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(source)).not.toThrow();
      for (const specifier of importsOf(source)) {
        expect(specifier.includes("postui")).toBe(false);
      }
    });
  }

  test("vitest output uses vitest's own describe/test/expect", () => {
    const source = renderTest("vitest", opts);
    expect(source).toContain('import { describe, expect, test } from "vitest"');
    expect(source).toContain("test.skipIf(");
    expect(source).toContain("expect(response.status).toBeLessThan(500)");
    expect(importsOf(source)).toEqual(["vitest", "../requests/users.ts"]);
  });

  test("bun:test output uses bun:test's own describe/test/expect", () => {
    const source = renderTest("bun:test", opts);
    expect(source).toContain('import { describe, expect, test } from "bun:test"');
    expect(source).toContain("test.skipIf(");
    expect(source).toContain("expect(response.status).toBeLessThan(500)");
    expect(importsOf(source)).toEqual(["bun:test", "../requests/users.ts"]);
  });

  test("node:test output uses node:test with assert", () => {
    const source = renderTest("node:test", opts);
    expect(source).toContain('import { describe, test } from "node:test"');
    expect(source).toContain('import assert from "node:assert/strict"');
    expect(source).toContain('{ skip: skipReason }');
    expect(source).toContain("assert.ok(response.status < 500");
    expect(source).not.toContain("expect(");
    expect(importsOf(source)).toEqual(["node:test", "node:assert/strict", "../requests/users.ts"]);
  });

  for (const target of TEST_TARGETS) {
    test(`${target}: reads environment values at test time`, () => {
      const source = renderTest(target, opts);
      expect(source).toContain("process.env[");
      expect(source).toContain("missingEnvNames(request)");
      expect(source).toContain('from "../requests/users.ts"');
    });
    test(`${target}: lets fetch set the multipart boundary, whatever the header casing`, () => {
      const source = renderTest(target, opts);
      expect(source).toContain('name.toLowerCase() === "content-type"');
    });
  }

  test("the header marks the file as postui-generated", () => {
    for (const target of TEST_TARGETS) {
      expect(renderTest(target, opts).startsWith("// Generated by postui gen")).toBe(true);
    }
  });
});
