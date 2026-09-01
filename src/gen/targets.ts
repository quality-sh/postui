/**
 * The test targets postui gen emits code for. This module is the single
 * declaration of supported targets: generation may only ever produce files
 * for frameworks listed here, in this order (also the detection precedence).
 */
export const TEST_TARGETS = ["vitest", "bun:test", "node:test"] as const;

export type TestTarget = (typeof TEST_TARGETS)[number];

/**
 * Package.json dependency names that declare each target. A project states
 * its runtime through the packages it declares: the vitest runner itself,
 * or the type packages for the runtime whose built-in test runner it uses.
 * Names are checked against dependencies and devDependencies together.
 */
export const DETECT_MARKERS: Record<TestTarget, readonly string[]> = {
  vitest: ["vitest"],
  "bun:test": ["bun-types", "@types/bun"],
  "node:test": ["@types/node"],
};
