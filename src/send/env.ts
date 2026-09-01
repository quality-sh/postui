// @provenance rule: rule_env_resolve_at_send
// @provenance rule: rule_env_missing_fails_fast
// @provenance rule: rule_env_names_only_in_files
// @provenance rule: rule_env_only_credentials
//
// Saved files hold credential NAMES only; values are read from the
// environment once, here, when the send starts — never from arguments
// (the CLI refuses every option that is not --json / --body-bytes).
import { extractEnvRefs } from "../save/credentials.ts";
import { MissingEnvError } from "./errors.ts";

/** Every environment name the saved request references, in a stable order. */
export function collectEnvNames(request: {
  url: string;
  headers: Record<string, string>;
  body: null | string | Array<{ name: string; value?: string; file?: string }>;
}): string[] {
  const names: string[] = [];
  const add = (text: string): void => {
    for (const name of extractEnvRefs(text)) {
      if (!names.includes(name)) names.push(name);
    }
  };
  add(request.url);
  for (const value of Object.values(request.headers)) add(value);
  if (typeof request.body === "string") {
    add(request.body);
  } else if (request.body !== null) {
    for (const entry of request.body) {
      if (entry.value !== undefined) add(entry.value);
      if (entry.file !== undefined) add(entry.file);
    }
  }
  return names;
}

/**
 * All-or-nothing resolution: every referenced name must be set in the
 * environment or the whole send fails with one MissingEnvError naming every
 * unset name (never any value). The caller must invoke this before any
 * network I/O — an unresolved send never touches the network.
 */
export function resolveEnvValues(names: string[]): Map<string, string> {
  const missing = names.filter(name => process.env[name] === undefined);
  if (missing.length > 0) {
    throw new MissingEnvError({
      names: missing,
      message:
        `${missing.length === 1 ? "environment name is" : "environment names are"} not set: ` +
        missing.join(", ") +
        " — set them in the environment; postui does not take credential values as arguments",
    });
  }
  return new Map(names.map(name => [name, process.env[name] as string]));
}
