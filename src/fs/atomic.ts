// @provenance rule: rule_gen_emit_no_partial
import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Replace dest atomically: write a temp sibling, then rename over the
 * destination. A failure at any point leaves the prior destination
 * byte-for-byte unchanged and never exposes a partial file.
 */
export async function writeFileAtomic(dest: string, content: string): Promise<void> {
  const tmp = join(dirname(dest), `.${basename(dest)}.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, content, "utf8");
    await rename(tmp, dest);
  } catch (cause) {
    await rm(tmp, { force: true }).catch(() => {});
    throw cause;
  }
}
