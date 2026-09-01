import { Data } from "effect";

export class SaveNameError extends Data.TaggedError("SaveNameError")<
  { message: string }
> {}

/**
 * A module name must be safe as a plain filename in any POSIX checkout:
 * letters, digits, dot, underscore, hyphen — starting with a letter or digit.
 * This rejects traversal ("..", "a/b") and anything shell- or percent-encoded.
 */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** True when name is a safe plain module filename component (see NAME_PATTERN). */
export function isValidModuleName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

/**
 * Pick the module name for a saved request: the --name flag wins, otherwise
 * the name is derived from the URL's last path segment (falling back to the
 * hostname when the path has no segments, e.g. "https://api.dev/").
 */
export function resolveModuleName(
  opts: { flag: string | null; url: URL },
): string {
  if (opts.flag !== null) {
    return validate(stripTsSuffix(opts.flag), `--name "${opts.flag}"`);
  }
  return validate(deriveFromUrl(opts.url), `derived from ${opts.url.href}`);
}

function stripTsSuffix(name: string): string {
  return name.endsWith(".ts") ? name.slice(0, -3) : name;
}

function deriveFromUrl(url: URL): string {
  const segments = url.pathname.split("/").filter(s => s.length > 0);
  const last = segments[segments.length - 1];
  return last ?? url.hostname;
}

function validate(name: string, source: string): string {
  if (!NAME_PATTERN.test(name)) {
    throw new SaveNameError({
      message:
        `invalid module name ${source}: "${name}" — use letters, digits, ".", "_"` +
        ` or "-" (starting with a letter or digit), or pass --name`,
    });
  }
  return name;
}
