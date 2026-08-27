#!/usr/bin/env bun
import { Schema } from "effect";
import { parseCurl, CurlParseError } from "./curl/parse.ts";
import { display } from "./format.ts";
import { RequestSpecJson } from "./schema.ts";

function usage(): never {
  console.error(`postui — the terminal postman

Usage:
  postui <curl ...>          Parse a curl command (paste it raw, quotes included)
  postui --json <curl ...>   Emit the structured request as JSON

Examples:
  postui 'curl -X POST https://api.dev/users -H "Authorization: Bearer $T" -d '{"name":"ben"}'
`);
  process.exit(2);
}

export async function main(argv: string[]): Promise<number> {
  let jsonMode = false;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") jsonMode = true;
    else rest.push(argv[i]!);
  }
  if (rest.length === 0) usage();

  // Invoked as `postui curl ...` in a shell, argv arrives pre-split. Rejoin
  // without re-tokenizing except when the caller passed one quoted string,
  // which the shell already collapsed into a single word containing spaces.
  const joined =
    rest.length > 1 || !/\s/.test(rest[0]!)
      ? rest.join(" ")
      : rest[0]!;

  try {
    const { spec, warnings } = parseCurl(joined);
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
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
