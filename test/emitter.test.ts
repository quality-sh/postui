import { describe, expect, test } from "bun:test";
import { renderModule } from "../src/save/emitter.ts";
import { parseCurl } from "../src/curl/parse.ts";
import type { RequestSpec } from "../src/types.ts";
import { pathToFileURL } from "node:url";

function specOf(curl: string): RequestSpec {
  return parseCurl(curl).spec;
}

async function importModule(source: string): Promise<{ request: Record<string, unknown> }> {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "postui-emitter-"));
  const file = join(dir, "saved.ts");
  await writeFile(file, source, "utf8");
  return await import(pathToFileURL(file).href);
}

describe("renderModule", () => {
  test("renders a GET with no body", () => {
    const source = renderModule(specOf("curl https://api.dev/users"));
    expect(source).toContain('method: "GET"');
    expect(source).toContain('url: "https://api.dev/users"');
    expect(source).toContain("body: null");
  });

  test("renders headers as a plain record", () => {
    const source = renderModule(
      specOf(`curl https://api.dev -H 'X-One: 1' -H 'X-Two: 2'`),
    );
    expect(source).toContain('"X-One": "1"');
    expect(source).toContain('"X-Two": "2"');
  });

  test("keeps $NAME references in header values verbatim", () => {
    const source = renderModule(
      specOf(`curl https://api.dev -H 'Authorization: Bearer $POSTUI_TEST_TOKEN'`),
    );
    expect(source).toContain('"Authorization": "Bearer $POSTUI_TEST_TOKEN"');
  });

  test("renders a raw body as a string", () => {
    const source = renderModule(specOf(`curl https://api.dev -d '{"name":"ben"}'`));
    expect(source).toContain(`body: "{\\"name\\":\\"ben\\"}"`);
  });

  test("renders form entries", () => {
    const source = renderModule(
      specOf(`curl https://up.io -F name=ben -F avatar=@/tmp/me.png`),
    );
    expect(source).toContain(`{ name: "name", value: "ben" }`);
    expect(source).toContain(`{ name: "avatar", file: "/tmp/me.png" }`);
  });

  test("round-trips through the TS runtime with quoting, newlines and unicode", async () => {
    // A real newline inside the single-quoted body; café-✓ raw UTF-8.
    const curl =
      `curl -X POST 'https://api.dev/users' -H 'X-Quote: say "hi"' ` +
      `-H 'X-Unicode: café-✓' --data-raw '{"text":"line1\nline2"}'`;
    const mod = await importModule(renderModule(specOf(curl)));
    expect(mod.request.method).toBe("POST");
    expect(mod.request.url).toBe("https://api.dev/users");
    const headers = mod.request.headers as Record<string, string>;
    expect(headers["X-Quote"]).toBe('say "hi"');
    expect(headers["X-Unicode"]).toBe("café-✓");
    expect(mod.request.body).toBe('{"text":"line1\nline2"}');
  });
});
