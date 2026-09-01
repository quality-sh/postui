#!/usr/bin/env bun
import { Data, Schema } from "effect";
import { parseCurl, CurlParseError } from "./curl/parse.ts";
import { display } from "./format.ts";
import { generateTests, GenCollisionError, UnsupportedTargetError } from "./gen/gen.ts";
import { FrameworkNotDetectedError } from "./gen/detect.ts";
import { SavedModuleError, UnknownRequestError } from "./gen/load.ts";
import { RequestSpecJson } from "./schema.ts";
import { saveRequest, SaveCollisionError } from "./save/save.ts";
import { SaveNameError } from "./save/name.ts";
import {
  BadSendDefinitionError,
  MissingEnvError,
  NetworkPathError,
  TransportFailureError,
  UnknownSendFlagError,
} from "./send/errors.ts";
import { renderDigest, renderJson, sendRequest } from "./send/send.ts";
import { scrubSecrets } from "./send/redact.ts";
import { NoTestCommandError, runTestCommand } from "./run/exec.ts";

class UsageError extends Data.TaggedError("UsageError") {}

function usage(): never {
  console.error(`postui — the terminal postman

Usage:
  postui <curl ...>          Parse a curl command (paste it raw, quotes included)
  postui --json <curl ...>   Emit the structured request as JSON
  postui save [--name <n>] [--force] <curl ...>
                             Save the request as requests/<n>.ts
  postui gen [--framework <f>]
                             Generate tests/<n>.test.ts from saved requests
                             (<f>: vitest | bun:test | node:test; default: detected)
  postui run                 Execute the project's own test command
                             (package.json scripts.test); no built-in runner
  postui send [--json] [--body-bytes <n>] <name>
                             Send saved requests/<name>.ts once, non-interactively.
                             Bounded redacted digest by default (256-byte body
                             excerpt); --body-bytes <n> widens only that window.
                             Exit: 0 sent, 1 API rejected the send, 2 postui
                             could not make the send. Credential values come
                             only from the environment, never from arguments.

Examples:
  postui 'curl -X POST https://api.dev/users -H "Authorization: Bearer $T" -d '{"name":"ben"}''
  postui save 'curl https://api.dev/users'
  postui gen
  postui send users
  postui send users --json --body-bytes 4096
`);
  throw new UsageError();
}

/** Rejoin argv into one curl string without re-tokenizing split words. */
function joinCurl(words: string[]): string {
  const first = words[0];
  if (first === undefined) usage();
  return words.length > 1 || !/\s/.test(first) ? words.join(" ") : first;
}

/** Consume save flags; everything from the first non-flag word on is curl. */
function parseSaveArgs(args: string[]): { name: string | null; force: boolean; words: string[] } {
  let name: string | null = null;
  let force = false;
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--name") {
      const value = args[i + 1];
      if (value === undefined) usage();
      name = value;
      i += 2;
    } else if (arg === "--force") {
      force = true;
      i++;
    } else {
      break;
    }
  }
  const words = args.slice(i);
  if (words.length === 0) usage();
  return { name, force, words };
}

/** Consume gen flags; gen takes no positional arguments. */
function parseGenArgs(args: string[]): { framework: string | null } {
  let framework: string | null = null;
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--framework") {
      const value = args[i + 1];
      if (value === undefined) usage();
      framework = value;
      i += 2;
    } else {
      usage();
    }
  }
  return { framework };
}

async function runGen(args: string[]): Promise<number> {
  const { framework } = parseGenArgs(args);
  try {
    const result = await generateTests({ framework });
    if (result.files.length === 0) {
      console.error(
        "no saved requests found in requests/ — nothing to generate (save one with postui save)",
      );
      return 0;
    }
    for (const file of result.files) {
      console.log(`generated ${file}`);
    }
    return 0;
  } catch (e) {
    if (
      e instanceof FrameworkNotDetectedError ||
      e instanceof UnsupportedTargetError ||
      e instanceof SavedModuleError ||
      e instanceof GenCollisionError
    ) {
      console.error(`error: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

async function runSave(args: string[]): Promise<number> {
  const { name, force, words } = parseSaveArgs(args);
  try {
    const result = await saveRequest(joinCurl(words), { name, force });
    for (const w of result.warnings) {
      console.error(`warning: ${w.flag} ignored (${w.message})`);
    }
    for (const what of result.redacted) {
      console.error(
        `warning: credential-like value in ${what} not saved` +
          ` — reference an environment variable with $NAME instead`,
      );
    }
    console.log(`saved ${result.path}`);
    return 0;
  } catch (e) {
    if (e instanceof CurlParseError) {
      console.error(`error: ${e.message}`);
      return 1;
    }
    if (e instanceof SaveNameError || e instanceof SaveCollisionError) {
      console.error(`error: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

/** Consume send flags; exactly one positional <name> is required. */
function parseSendArgs(args: string[]): { name: string; json: boolean; bodyWindow: number | null } {
  let name: string | null = null;
  let json = false;
  let bodyWindow: number | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--body-bytes") {
      const value = args[i + 1];
      if (value === undefined || !/^[0-9]+$/.test(value)) {
        throw new UnknownSendFlagError({
          message: "--body-bytes needs a non-negative integer (a body window in bytes)",
        });
      }
      bodyWindow = Number.parseInt(value, 10);
      i++;
    } else if (arg.startsWith("-")) {
      // @provenance rule: rule_env_only_credentials
      // Every option outside the strict set is refused before anything
      // loads, so a credential value can never enter through an argument.
      throw new UnknownSendFlagError({
        message:
          `unknown option "${arg}" — postui send takes only --json and ` +
          `--body-bytes <n>; credential values resolve from the environment ` +
          `and cannot be passed as arguments`,
      });
    } else if (name === null) {
      name = arg;
    } else {
      usage();
    }
  }
  if (name === null) usage();
  return { name, json, bodyWindow };
}

// @provenance rule: rule_agent_streams_split
// @provenance rule: rule_agent_exit_status
// Send data (digest, or the sole JSON value in --json mode) goes to stdout;
// the named error goes to stderr; nothing else is printed on either stream.
// Exit: 0 sent, 1 rejected or transport failure after the send started,
// 2 postui could not make the send.
async function runSend(args: string[]): Promise<number> {
  try {
    const { name, json, bodyWindow } = parseSendArgs(args);
    const { outcome, secrets } = await sendRequest({
      name,
      bodyWindow: bodyWindow ?? undefined,
    });
    console.log(json ? renderJson(outcome, secrets) : renderDigest(outcome, secrets));
    if (outcome.redirectedTo !== null) {
      // Diagnostics live on stderr and are scrubbed like every other output.
      console.error(
        `warning: followed redirect; output describes the final response at ` +
          `${scrubSecrets(outcome.redirectedTo, secrets)}`,
      );
    }
    if (outcome.kind === "rejected" && outcome.error !== undefined) {
      printNamedError(outcome.error);
      return 1;
    }
    return 0;
  } catch (e) {
    if (e instanceof TransportFailureError) {
      printNamedError(e);
      return 1;
    }
    if (
      e instanceof MissingEnvError ||
      e instanceof UnknownRequestError ||
      e instanceof SavedModuleError ||
      e instanceof BadSendDefinitionError ||
      e instanceof NetworkPathError ||
      e instanceof UnknownSendFlagError
    ) {
      printNamedError(e);
      return 2;
    }
    throw e;
  }
}

/** Only the named typed error — one line: tag plus (pre-redacted) message. */
function printNamedError(e: { _tag: string; message: string }): void {
  console.error(`error: ${e._tag}: ${e.message}`);
}

async function runRun(args: string[]): Promise<number> {
  if (args.length > 0) usage();
  try {
    return await runTestCommand();
  } catch (e) {
    if (e instanceof NoTestCommandError) {
      console.error(`error: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

// @provenance rule: rule_json_schema_gate
// @provenance rule: rule_typed_failures
export async function main(argv: string[]): Promise<number> {
  try {
    if (argv[0] === "save") return await runSave(argv.slice(1));
    if (argv[0] === "gen") return await runGen(argv.slice(1));
    if (argv[0] === "send") return await runSend(argv.slice(1));
    if (argv[0] === "run") return await runRun(argv.slice(1));

    let jsonMode = false;
    const rest: string[] = [];
    for (const arg of argv) {
      if (arg === "--json") jsonMode = true;
      else rest.push(arg);
    }
    if (rest.length === 0) usage();

    try {
      const { spec, warnings } = parseCurl(joinCurl(rest));
      for (const w of warnings) {
        console.error(`warning: ${w.flag} ignored (${w.message})`);
      }
      if (jsonMode) {
        const payload = Schema.encodeSync(RequestSpecJson)({
          method: spec.method,
          url: spec.url.href,
          headers: spec.headers,
          body: spec.body,
        });
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(display(spec));
      }
      return 0;
    } catch (e) {
      if (e instanceof CurlParseError) {
        console.error(`error: ${e.message}`);
        return 1;
      }
      throw e;
    }
  } catch (e) {
    if (e instanceof UsageError) return 2;
    throw e;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
