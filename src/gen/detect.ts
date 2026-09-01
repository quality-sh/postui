import { Data } from "effect";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DETECT_MARKERS, TEST_TARGETS } from "./targets.ts";
import type { TestTarget } from "./targets.ts";

export class FrameworkNotDetectedError extends Data.TaggedError(
  "FrameworkNotDetectedError",
)<{ message: string }> {}

/**
 * Select the target test framework from a parsed package.json: the first
 * target whose marker package is declared (dependencies or
 * devDependencies) wins, in TEST_TARGETS order. Order is the precedence —
 * explicit runner packages before runtime type packages.
 */
export function detectFramework(pkg: unknown): TestTarget {
  const declared = declaredNames(pkg);
  for (const target of TEST_TARGETS) {
    if (DETECT_MARKERS[target].some(name => declared.has(name))) return target;
  }
  throw new FrameworkNotDetectedError({
    message:
      "no supported test framework found in package.json — postui gen can " +
      "generate for vitest, bun:test, and node:test; pass --framework to choose one",
  });
}

/** Read and parse <root>/package.json, mapping failures to detection errors. */
export async function readPackageJson(root: string): Promise<unknown> {
  const path = join(root, "package.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new FrameworkNotDetectedError({
      message: `no package.json found at ${path} — postui gen detects the test framework from it, or pass --framework`,
    });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new FrameworkNotDetectedError({
      message: `package.json at ${path} is not valid JSON — fix it or pass --framework`,
    });
  }
}

function declaredNames(pkg: unknown): Set<string> {
  const names = new Set<string>();
  if (typeof pkg !== "object" || pkg === null) return names;
  const record = pkg as Record<string, unknown>;
  for (const section of ["dependencies", "devDependencies"]) {
    const deps = record[section];
    if (typeof deps === "object" && deps !== null) {
      for (const name of Object.keys(deps)) names.add(name);
    }
  }
  return names;
}
