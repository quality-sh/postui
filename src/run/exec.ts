// @provenance rule: rule_run_user_command
// @provenance rule: rule_run_exit_status
// @provenance rule: rule_run_no_command_error
//
// `postui run` executes the test command the user's own project defines in
// package.json scripts.test, verbatim, through sh. postui ships no built-in
// test runner: a project with no test command is a named error, and the
// child's exit status (or 128+signal for a signaled child) is postui's exit
// status. Child stdio is inherited so live test output streams through.
import { Data } from "effect";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { constants } from "node:os";

export class NoTestCommandError extends Data.TaggedError("NoTestCommandError")<{
  message: string;
}> {}

export interface RunOptions {
  /** Project root holding package.json. Defaults to the working directory. */
  root?: string;
}

/**
 * Execute the project's own test command and resolve to its exit status.
 * The command runs exactly as defined — postui adds no runner, no flags,
 * no environment of its own.
 */
export async function runTestCommand(opts: RunOptions = {}): Promise<number> {
  const root = opts.root ?? process.cwd();
  const script = await readTestScript(root);
  const child = Bun.spawn(["sh", "-c", script], {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== null) return code;
  const signal = child.signalCode ?? "SIGTERM";
  return 128 + (constants.signals[signal] ?? 1);
}

/** scripts.test as a non-empty string, or a named error explaining why not. */
async function readTestScript(root: string): Promise<string> {
  const path = join(root, "package.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new NoTestCommandError({
      message:
        `no package.json found at ${path} — postui run executes the test ` +
        `command your project defines in package.json scripts.test`,
    });
  }
  let scripts: unknown;
  try {
    scripts = (JSON.parse(text) as Record<string, unknown>)["scripts"];
  } catch {
    throw new NoTestCommandError({
      message: `package.json at ${path} is not valid JSON — fix it to run its test command`,
    });
  }
  const test = typeof scripts === "object" && scripts !== null
    ? (scripts as Record<string, unknown>)["test"]
    : undefined;
  if (typeof test !== "string" || test.trim() === "") {
    throw new NoTestCommandError({
      message:
        `package.json at ${path} defines no test command — add a "test" script; ` +
        `postui has no built-in test runner`,
    });
  }
  return test;
}
