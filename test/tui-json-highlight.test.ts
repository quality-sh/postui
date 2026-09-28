import { describe, expect, test } from "bun:test";
import { highlightJson, highlightJsonValue } from "../src/tui/json-highlight.ts";
import type { JsonLine, JsonTokenKind } from "../src/tui/json-highlight.ts";

/** A laid-out result as plain text lines. */
function texts(lines: readonly JsonLine[]): string[] {
  return lines.map(line => line.map(span => span.text).join(""));
}

/** Every non-plain span as `kind:text`, in order — the coloring contract. */
function kinds(lines: readonly JsonLine[]): string[] {
  return lines.flatMap(line =>
    line.filter(span => span.kind !== "plain").map(span => `${span.kind}:${span.text}`),
  );
}

/** The kind of the first span whose text is exactly `text`. */
function kindOf(lines: readonly JsonLine[], text: string): JsonTokenKind | undefined {
  return lines.flat().find(span => span.text === text)?.kind;
}

describe("highlightJson", () => {
  test("pretty-prints an object with 2-space indent, like JSON.stringify(v, null, 2)", () => {
    const source = `{"id":"usr_1","age":36,"active":true,"manager":null}`;
    const result = highlightJson(source);
    expect(result.format).toBe("json");
    expect(texts(result.lines)).toEqual(JSON.stringify(JSON.parse(source), null, 2).split("\n"));
  });

  test("types every token: keys, strings, numbers, booleans, null, punctuation", () => {
    const { lines } = highlightJson(`{"name":"Ada","age":36,"ok":false,"boss":null}`);
    expect(kinds(lines)).toEqual([
      "punctuation:{",
      "key:\"name\"",
      "punctuation::",
      "string:\"Ada\"",
      "punctuation:,",
      "key:\"age\"",
      "punctuation::",
      "number:36",
      "punctuation:,",
      "key:\"ok\"",
      "punctuation::",
      "boolean:false",
      "punctuation:,",
      "key:\"boss\"",
      "punctuation::",
      "null:null",
      "punctuation:}",
    ]);
  });

  test("nested objects and arrays indent one level per depth", () => {
    const source = `{"a":{"b":[1,{"c":"d"}]},"e":[true,[null]]}`;
    const { lines, format } = highlightJson(source);
    expect(format).toBe("json");
    expect(texts(lines)).toEqual(JSON.stringify(JSON.parse(source), null, 2).split("\n"));
    expect(texts(lines)).toContain("        \"c\": \"d\"");
  });

  test("empty containers stay on one line, at the top level and nested", () => {
    expect(texts(highlightJson("{}").lines)).toEqual(["{}"]);
    expect(texts(highlightJson(" [ ] ").lines)).toEqual(["[]"]);
    const nested = highlightJson(`{"projects":[],"meta":{},"list":[{},[]]}`);
    expect(texts(nested.lines)).toEqual([
      "{",
      "  \"projects\": [],",
      "  \"meta\": {},",
      "  \"list\": [",
      "    {},",
      "    []",
      "  ]",
      "}",
    ]);
  });

  test("a top-level array of scalars puts one element per line", () => {
    expect(texts(highlightJson(`["a",1,-2.5e3,true]`).lines)).toEqual([
      "[",
      "  \"a\",",
      "  1,",
      "  -2.5e3,",
      "  true",
      "]",
    ]);
  });

  test("top-level scalars are one line of their kind", () => {
    expect(highlightJson("42").lines).toEqual([[{ kind: "number", text: "42" }]]);
    expect(highlightJson(" \"hi\" ").lines).toEqual([[{ kind: "string", text: "\"hi\"" }]]);
    expect(highlightJson("null").lines).toEqual([[{ kind: "null", text: "null" }]]);
  });

  test("escaped strings render exactly as written: quotes, backslashes, \\uXXXX stay escaped", () => {
    const source = String.raw`{"q":"say \"hi\"","path":"C:\\tmp\/x","nl":"a\nb","u":"caf\u00e9"}`;
    const { lines, format } = highlightJson(source);
    expect(format).toBe("json");
    expect(kindOf(lines, String.raw`"say \"hi\""`)).toBe("string");
    expect(kindOf(lines, String.raw`"C:\\tmp\/x"`)).toBe("string");
    // An escaped newline is two characters on ONE line, never a line break.
    expect(texts(lines)).toContain(String.raw`  "nl": "a\nb",`);
    // Escapes are not decoded (a scrubbed secret must not reappear by decoding).
    expect(kindOf(lines, String.raw`"caf\u00e9"`)).toBe("string");
  });

  test("an escaped quote inside a key does not end the key", () => {
    const { lines } = highlightJson(String.raw`{"a\"b":1}`);
    expect(kindOf(lines, String.raw`"a\"b"`)).toBe("key");
  });

  test("unicode passes through untouched: accents, CJK, emoji", () => {
    const { lines, format } = highlightJson(`{"名前":"Zoë 🚀","city":"東京"}`);
    expect(format).toBe("json");
    expect(texts(lines)).toEqual(["{", "  \"名前\": \"Zoë 🚀\",", "  \"city\": \"東京\"", "}"]);
    expect(kindOf(lines, "\"名前\"")).toBe("key");
  });

  test("numbers keep their source digits (no float round-trip)", () => {
    const { lines } = highlightJson(`{"big":12345678901234567890,"f":1.0,"e":1E+2}`);
    expect(kindOf(lines, "12345678901234567890")).toBe("number");
    expect(kindOf(lines, "1.0")).toBe("number");
    expect(kindOf(lines, "1E+2")).toBe("number");
  });

  test("already pretty or CRLF input re-lays out the same way", () => {
    const { lines, format } = highlightJson("{\r\n\t\"a\" :  [ 1 ,2 ]\r\n}\r\n");
    expect(format).toBe("json");
    expect(texts(lines)).toEqual(["{", "  \"a\": [", "    1,", "    2", "  ]", "}"]);
  });

  test("a leading byte-order mark is skipped", () => {
    expect(highlightJson("\uFEFF{\"a\":1}").format).toBe("json");
  });

  describe("not JSON: plain lines, passed through", () => {
    test("prose", () => {
      const result = highlightJson("hello\nworld");
      expect(result.format).toBe("text");
      expect(result.lines).toEqual([
        [{ kind: "plain", text: "hello" }],
        [{ kind: "plain", text: "world" }],
      ]);
    });

    test("blank lines stay blank and CRLF splits cleanly", () => {
      expect(texts(highlightJson("a\r\n\r\nb").lines)).toEqual(["a", "", "b"]);
    });

    test("empty and whitespace-only text", () => {
      expect(highlightJson("").format).toBe("text");
      expect(highlightJson("  ").format).toBe("text");
    });

    for (const [label, source] of [
      ["trailing comma", `{"a":1,}`],
      ["single quotes", `{'a':1}`],
      ["missing colon", `{"a" 1}`],
      ["unquoted key", `{a:1}`],
      ["leading zero", `[01]`],
      ["bare word", `[yes]`],
      ["raw control character in a string", "[\"a\tb\"]"],
      ["bad escape", String.raw`["\x41"]`],
      ["short unicode escape", String.raw`["\u12"]`],
      ["mismatched brackets", `{"a":[1}`],
      ["two documents", `{} {}`],
      ["NDJSON", "{\"a\":1}\n{\"a\":2}"],
      ["html", "<html><body>502</body></html>"],
    ] as const) {
      test(label, () => {
        const result = highlightJson(source);
        expect(result.format).toBe("text");
        expect(texts(result.lines)).toEqual(source.split(/\r?\n/));
      });
    }

    test("absurd nesting falls back instead of overflowing the stack", () => {
      const deep = `${"[".repeat(5000)}${"]".repeat(5000)}`;
      expect(highlightJson(deep).format).toBe("text");
    });
  });

  describe("truncated excerpts", () => {
    const whole = `{"id":"usr_01HVK8J7","tags":["math","engines"],"geo":{"lat":51.5},"ok":true}`;

    test("without the truncated flag, a cut document is not JSON", () => {
      const result = highlightJson(whole.slice(0, 30));
      expect(result.format).toBe("text");
      expect(texts(result.lines)).toEqual([whole.slice(0, 30)]);
    });

    test("with it, the prefix is laid out up to the cut", () => {
      const result = highlightJson(whole.slice(0, 47), { truncated: true });
      expect(result.format).toBe("partial");
      expect(texts(result.lines)).toEqual([
        "{",
        "  \"id\": \"usr_01HVK8J7\",",
        "  \"tags\": [",
        "    \"math\",",
        "    \"engines\"",
        "  ],",
      ]);
    });

    test("a cut inside a string keeps the partial string, typed", () => {
      const result = highlightJson(`{"id":"usr_01H`, { truncated: true });
      expect(result.format).toBe("partial");
      expect(texts(result.lines)).toEqual(["{", "  \"id\": \"usr_01H"]);
      expect(kindOf(result.lines, "\"usr_01H")).toBe("string");
    });

    test("a cut inside a key, an escape, a number, or a literal still lays out", () => {
      const cuts = [`{"ta`, String.raw`{"a":"x\u00`, "{\"a\":\"x\\", `{"a":-`, `{"a":1.`, `{"a":2e`, `{"a":tr`, `{"a":nu`];
      for (const cut of cuts) {
        expect(highlightJson(cut, { truncated: true }).format).toBe("partial");
      }
      const literal = highlightJson(`[fal`, { truncated: true });
      expect(kindOf(literal.lines, "fal")).toBe("boolean");
    });

    test("a cut right after a separator drops the indentation-only line", () => {
      const result = highlightJson(`{"a":1,`, { truncated: true });
      expect(texts(result.lines)).toEqual(["{", "  \"a\": 1,"]);
    });

    test("a syntax error before the cut is still not JSON", () => {
      expect(highlightJson(`{"a":1,,"b`, { truncated: true }).format).toBe("text");
    });

    test("a complete document flagged truncated is still JSON", () => {
      expect(highlightJson(`{"a":1}`, { truncated: true }).format).toBe("json");
    });
  });
});

describe("highlightJsonValue", () => {
  test("lays out an in-memory value", () => {
    const { lines, format } = highlightJsonValue({ name: "Ada", tags: ["x"], n: 1, ok: null });
    expect(format).toBe("json");
    expect(texts(lines)).toEqual([
      "{",
      "  \"name\": \"Ada\",",
      "  \"tags\": [",
      "    \"x\"",
      "  ],",
      "  \"n\": 1,",
      "  \"ok\": null",
      "}",
    ]);
  });

  test("a string value is a JSON string, not text to parse", () => {
    expect(highlightJsonValue("{}").lines).toEqual([[{ kind: "string", text: "\"{}\"" }]]);
  });

  test("values JSON cannot hold render as plain text", () => {
    expect(highlightJsonValue(undefined)).toEqual({ format: "text", lines: [[{ kind: "plain", text: "undefined" }]] });
  });
});
