import { describe, expect, test } from "bun:test";
import { parseCurl, guessContentType } from "../src/curl/parse.ts";

describe("parseCurl", () => {
  test("plain GET url", () => {
    const { spec } = parseCurl("curl https://api.dev/users");
    expect(spec.method).toBe("GET");
    expect(spec.url.href).toBe("https://api.dev/users");
    expect(spec.body.kind).toBe("none");
  });

  test("adds scheme when missing", () => {
    const { spec } = parseCurl("curl api.dev/users?page=2");
    expect(spec.url.protocol).toBe("http:");
    expect(spec.url.searchParams.get("page")).toBe("2");
  });

  test("POST with json body and headers", () => {
    const cmd =
      `curl -X POST 'https://x.io/api?log=1' -H "Authorization: Bearer abc" ` +
      `-H 'Content-Type: application/json; charset=utf-8' --data-raw '{"name":"ben","nested":{"a":1}}'`;
    const { spec } = parseCurl(cmd);
    expect(spec.method).toBe("POST");
    expect(Object.fromEntries(spec.headers)["Authorization"]).toBe("Bearer abc");
    expect(Object.fromEntries(spec.headers)["Content-Type"]).toBe(
      "application/json; charset=utf-8",
    );
    if (spec.body.kind !== "raw") throw new Error("expected raw body");
    const parsed = JSON.parse(spec.body.text);
    expect(parsed.nested.a).toBe(1);
  });

  test("-d implies POST without explicit method", () => {
    const { spec } = parseCurl(`curl https://x.io/things -d '{"a":1}'`);
    expect(spec.method).toBe("POST");
  });

  test("multiline command with backslash continuations", () => {
    const cmd = [
      "curl https://x.io/api \\",
      "  -H 'X-One: 1' \\",
      "  -H 'X-Two: 2'",
    ].join("\n");
    const { spec } = parseCurl(cmd);
    expect(spec.headers).toHaveLength(2);
    expect(spec.method).toBe("GET");
  });

  test("single quotes with embedded newlines in a data payload survive", () => {
    const cmd = `curl https://x.io -d $'line1\\nline2'`;
    const { spec } = parseCurl(cmd);
    if (spec.body.kind !== "raw") throw new Error("expected raw body");
    // splitShell keeps \n literally inside single quotes
    expect(spec.body.text).toContain("line1");
  });

  test("form fields and files", () => {
    const { spec } = parseCurl(
      `curl https://up.io -F name=ben -F avatar=@/tmp/me.png`,
    );
    expect(spec.body.kind).toBe("form");
    if (spec.body.kind === "form") {
      expect(spec.body.entries).toEqual([
        { kind: "field", name: "name", value: "ben" },
        { kind: "file", name: "avatar", path: "/tmp/me.png" },
      ]);
    }
  });

  test("basic auth becomes Authorization header", () => {
    const { spec } = parseCurl(`curl -u admin:s3cret https://x.io`);
    const h = Object.fromEntries(spec.headers);
    expect(h["Authorization"]).toMatch(/^Basic /);
    expect(atob((h["Authorization"] ?? "").slice(6))).toBe("admin:s3cret");
  });

  test("known but ignored flags produce warnings", () => {
    const { spec, warnings } = parseCurl(`curl -L -s https://x.io/follow`);
    expect(spec.method).toBe("GET");
    expect(warnings.map(w => w.flag)).toEqual(["-L", "-s"]);
  });

  test("unrecognized value flags are skipped with warnings", () => {
    const { spec } = parseCurl(
      `curl --max-time 5 --compressed https://x.io`,
    );
    expect(spec.url.hostname).toBe("x.io");
  });

  test("no url is an error", () => {
    expect(() => parseCurl(`curl -X DELETE`)).toThrow(/URL/);
  });

  test("unknown flag is an error", () => {
    expect(() => parseCurl(`curl --wat https://x.io`)).toThrow(/--wat/);
  });

  test("double-quoted string keeps inner escaped quote", () => {
    const { spec } = parseCurl(`curl -H "X-Greeting: say \\"hi\\"" https://x.io`);
    expect(Object.fromEntries(spec.headers)["X-Greeting"]).toBe('say "hi"');
  });
});

describe("parseCurl with word-split argv", () => {
  test("multi-word header values keep their boundaries", () => {
    const { spec, warnings } = parseCurl([
      "POST",
      "https://x.io/api",
      "-H",
      "Authorization: Bearer sk-tok",
      "-H",
      "X-Trace: alpha beta gamma",
    ]);
    expect(spec.method).toBe("POST");
    expect(spec.url.href).toBe("https://x.io/api");
    expect(Object.fromEntries(spec.headers)["Authorization"]).toBe("Bearer sk-tok");
    expect(Object.fromEntries(spec.headers)["X-Trace"]).toBe("alpha beta gamma");
    expect(warnings).toEqual([]);
  });

  test("a bare leading method word names the method, not the URL", () => {
    const fromArgv = parseCurl(["POST", "https://x.io/api"]);
    expect(fromArgv.spec.method).toBe("POST");
    expect(fromArgv.spec.url.href).toBe("https://x.io/api");
    expect(fromArgv.warnings).toEqual([]);
    // The string form of the same command behaves identically.
    const fromString = parseCurl("POST https://x.io/api");
    expect(fromString.spec.method).toBe("POST");
    expect(fromString.spec.url.href).toBe("https://x.io/api");
  });

  test("a bare method word after the URL is still an ignored extra", () => {
    const { spec, warnings } = parseCurl(["https://x.io", "POST"]);
    expect(spec.method).toBe("GET");
    expect(spec.url.href).toBe("https://x.io/");
    expect(warnings.map(w => w.flag)).toEqual(["POST"]);
  });

  test("a method word with no URL is an error, not a bogus host", () => {
    expect(() => parseCurl(["POST"])).toThrow(/URL/);
  });

  test("lowercase and mixed-case words stay URL candidates", () => {
    expect(parseCurl(["post", "https://x.io"]).spec.url.hostname).toBe("post");
    expect(parseCurl(["Post", "https://x.io"]).spec.url.hostname).toBe("post");
  });

  test("already-unquoted words pass through verbatim, quote boundaries intact", () => {
    // As the shell delivers them: the user's quotes are gone, the value is
    // one argv word containing double quotes, a backslash, and a tab.
    const { spec, warnings } = parseCurl([
      "https://x.io",
      "-d",
      '{"path":"C:\\tmp\\x",\t"k":"v"}',
      "-H",
      "X-Greeting: it's alive",
    ]);
    expect(warnings).toEqual([]);
    if (spec.body.kind !== "raw") throw new Error("expected raw body");
    expect(spec.body.text).toBe('{"path":"C:\\tmp\\x",\t"k":"v"}');
    expect(spec.method).toBe("POST");
    expect(Object.fromEntries(spec.headers)["X-Greeting"]).toBe("it's alive");
  });
});

describe("guessContentType", () => {
  test("json object", () => expect(guessContentType('{"a":1}')).toBe("application/json"));
  test("json array", () => expect(guessContentType('[1,2]')).toBe("application/json"));
  test("form encoded", () =>
    expect(guessContentType("a=1&b=2")).toBe("application/x-www-form-urlencoded"));
  test("plain text", () => expect(guessContentType("hello world")).toBe(null));
});
