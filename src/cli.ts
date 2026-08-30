#!/usr/bin/env bun
import { Data, Schema } from "effect";
import { parseCurl, CurlParseError } from "./curl/parse.ts";
import { display } from "./format.ts";
import { RequestSpecJson } from "./schema.ts";
import { saveRequest, SaveCollisionError } from "./save/save.ts";
import { SaveNameError } from "./save/name.ts";

class UsageError extends Data.TaggedError("UsageError") {}

function usage(): never {
  console.error(`postui — the terminal postman

Usage:
  postui <curl ...>          Parse a curl command (paste it raw, quotes included)
  postui --json <curl ...>   Emit the structured request as JSON
  postui save [--name <n>] [--force] <curl ...>
                             Save the request as requests/<n>.ts

Examples:
  postui 'curl -X POST https://api.dev/users -H "Authorization: Bearer $T" -d '{"name":"ben"}''
  postui save 'curl https://api.dev/users'
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

// @provenance rule: rule_json_schema_gate
export async function main(argv: string[]): Promise<number> {
  try {
    if (argv[0] === "save") return await runSave(argv.slice(1));

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
