import { Data } from "effect";
import { extractEnvRefs, hasEnvRef } from "../save/credentials.ts";
import { renderModule } from "../save/emitter.ts";
import { isCredentialHeader } from "../send/redact.ts";
import type { RequestSpec } from "../types.ts";
import type { RequestDraft } from "./composer-send.ts";

/**
 * Ctrl+S: write the composer draft back to its own `requests/<name>.ts`.
 *
 * The module text comes from the same emitter `postui save` uses, so a
 * TUI-saved request is byte-for-byte the shape the CLI writes; the write
 * goes through the atomic writer, so a failed save leaves the old module
 * intact. Credentials follow the save rules: a credential header may hold
 * an env reference (`Bearer $API_TOKEN`) but never a literal value, and
 * URL userinfo must be a reference too. A draft that breaks either rule is
 * refused whole — nothing is stripped behind the user's back.
 */

/** The draft cannot be saved as it stands; the message says what to fix. */
export class DraftSaveRefusedError extends Data.TaggedError("DraftSaveRefusedError")<{
  readonly message: string;
}> {}

interface DraftModule {
  readonly source: string;
  /** The URL as the module stores it (URL normalization, e.g. a trailing `/`). */
  readonly url: string;
}

/** Render the draft as module source, or throw DraftSaveRefusedError. */
export function draftModule(draft: RequestDraft): DraftModule {
  for (const [name, value] of Object.entries(draft.headers)) {
    if (isCredentialHeader(name) && value !== "" && !hasEnvRef(value)) {
      throw new DraftSaveRefusedError({
        message: `not saved: ${name} holds a literal credential — use an env reference like $API_TOKEN`,
      });
    }
  }
  let url: URL;
  try {
    url = new URL(draft.url);
  } catch {
    throw new DraftSaveRefusedError({ message: "not saved: the URL does not parse" });
  }
  if ((url.username !== "" || url.password !== "") && !hasEnvRef(`${url.username}:${url.password}`)) {
    throw new DraftSaveRefusedError({
      message: "not saved: the URL carries a literal user:password — use env references",
    });
  }
  if (extractEnvRefs(url.href).join() !== extractEnvRefs(draft.url).join()) {
    // URL normalization (host lowercasing, `{}` escapes) would rewrite a
    // reference so it no longer resolves: refuse instead of corrupting it.
    throw new DraftSaveRefusedError({
      message: "not saved: an env reference in the URL would not survive — keep references in the path or query as $NAME",
    });
  }
  return { source: renderModule(specOf(draft, url)), url: url.href };
}

function specOf(draft: RequestDraft, url: URL): RequestSpec {
  return { method: draft.method, url, headers: Object.entries(draft.headers), body: bodyOf(draft.body) };
}

function bodyOf(body: RequestDraft["body"]): RequestSpec["body"] {
  if (body === null) return { kind: "none" };
  if (typeof body === "string") return { kind: "raw", contentType: null, text: body };
  return {
    kind: "form",
    entries: body.map(entry =>
      entry.file === undefined
        ? { kind: "field" as const, name: entry.name, value: entry.value ?? "" }
        : { kind: "file" as const, name: entry.name, path: entry.file },
    ),
  };
}
