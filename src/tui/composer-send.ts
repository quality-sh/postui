// @provenance rule: rule_redact_credential_headers
// @provenance rule: rule_redaction_no_off_switch
// @provenance rule: rule_env_missing_fails_fast
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCredentialHeader } from "../send/redact.ts";
import { sendRequest } from "../send/send.ts";
import type { SendResult } from "../send/send.ts";

/**
 * The TUI's bridge into the send pipeline.
 *
 * The composer edits an in-memory copy of the saved request ("draft"). To
 * execute it, the draft is serialized as a one-module snapshot directory and
 * handed to sendRequest() — the SAME module, loader, env resolution,
 * redaction, transport, and bounded capture the CLI uses. Nothing here
 * reimplements execution: the TUI's only addition is the snapshot write,
 * which exists so Bun's per-path module cache cannot serve a stale draft
 * (the same cache-buster src/tui/workspace.ts needs for reloads).
 */

/** The editable request state the composer carries for the send. */
export interface RequestDraft {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: null | string | Array<{ name: string; value?: string; file?: string }>;
}

/** A deep copy of a loaded request's definition: edits never touch the module. */
export function draftOf(request: {
  request: { method: string; url: string; headers: Record<string, string>; body: RequestDraft["body"] };
}): RequestDraft {
  return structuredClone(request.request);
}

/** The draft as saved-module source, exactly the shape `postui save` emits. */
function draftModuleSource(draft: RequestDraft): string {
  return `// Rendered by the postui TUI from the in-memory composer draft.\nexport const request = ${JSON.stringify(draft, null, 2)};\n`;
}

/**
 * Credential values written literally in the draft's credential headers
 * (the pipeline's own credential predicate — no TUI copy of the rules).
 *
 * The pipeline scrubs every output with the resolved ENV values; a literal
 * credential a hand-edited module carries was never an env value, so a
 * server echoing it back would slip past the env scrub on every output
 * path — CLI included. The TUI adds these literals to the scrub inputs:
 * over-redaction is always safe, and no redaction logic is reimplemented
 * here (rule_redaction_no_off_switch, rule_redact_env_values).
 */
export function draftCredentialValues(draft: RequestDraft): string[] {
  return Object.entries(draft.headers)
    .filter(([name]) => isCredentialHeader(name))
    .map(([, value]) => value)
    .filter(value => value.length > 0);
}

export interface DraftSendResult {
  result: SendResult;
  /** Wall-clock milliseconds around the pipeline call (send + capture). */
  latencyMs: number;
}

/**
 * Send the draft through the real pipeline. Env refs ($NAME) resolve inside
 * sendRequest at send time — all-or-nothing, fail-fast before any network
 * I/O; a MissingEnvError propagates out of here exactly as it does on the
 * CLI. `bodyWindow` is the CLI's --body-bytes equivalent: the only way to
 * widen the body view, with no unbounded mode.
 */
export async function sendDraft(
  draft: RequestDraft,
  name: string,
  bodyWindow?: number,
): Promise<DraftSendResult> {
  const snapshot = await mkdtemp(join(tmpdir(), "postui-tui-send-"));
  try {
    await writeFile(join(snapshot, `${name}.ts`), draftModuleSource(draft));
    const started = performance.now();
    const result = await sendRequest({
      name,
      requestsDir: snapshot,
      ...(bodyWindow === undefined ? {} : { bodyWindow }),
    });
    return { result, latencyMs: performance.now() - started };
  } finally {
    await rm(snapshot, { recursive: true, force: true });
  }
}
