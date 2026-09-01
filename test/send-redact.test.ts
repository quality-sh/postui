import { describe, expect, test } from "bun:test";
import { extractEnvRefs, substituteEnvRefs } from "../src/save/credentials.ts";
import { collectEnvNames, resolveEnvValues } from "../src/send/env.ts";
import { isCredentialHeader, redactHeaders, scrubSecrets, REDACTED } from "../src/send/redact.ts";
import { MissingEnvError } from "../src/send/errors.ts";

const CANARY = "agent-secret-91af";

// ---------------------------------------------------------------------------
// $NAME reference syntax (single source: src/save/credentials.ts)
// ---------------------------------------------------------------------------

describe("env reference extraction and substitution", () => {
  test("extracts $NAME and ${NAME}, deduplicated in order", () => {
    const names = extractEnvRefs("$A/$B/${A}/plain/${C_D}");
    expect(names).toEqual(["A", "B", "C_D"]);
  });

  test("text without references extracts to nothing", () => {
    expect(extractEnvRefs("https://api.dev/users?x=1")).toEqual([]);
    expect(extractEnvRefs("currency $100 and $1,000")).toEqual([]);
  });

  test("substitutes every reference and leaves unknown names untouched", () => {
    const values = new Map([["T", CANARY]]);
    expect(substituteEnvRefs("Bearer $T ${T} $NOPE", n => values.get(n))).toBe(
      `Bearer ${CANARY} ${CANARY} $NOPE`,
    );
  });
});

describe("fail-fast env resolution", () => {
  test("resolves every name from the environment", () => {
    process.env.POSTUI_TEST_TOKEN = CANARY;
    try {
      const values = resolveEnvValues(["POSTUI_TEST_TOKEN"]);
      expect(values.get("POSTUI_TEST_TOKEN")).toBe(CANARY);
    } finally {
      delete process.env.POSTUI_TEST_TOKEN;
    }
  });

  test("one unset name fails everything and names ALL missing names", () => {
    process.env.POSTUI_TEST_TOKEN = CANARY;
    let thrown: unknown;
    try {
      resolveEnvValues(["POSTUI_TEST_TOKEN", "POSTUI_TOKEN_A", "POSTUI_TOKEN_B"]);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(MissingEnvError);
    const err = thrown as MissingEnvError;
    expect(err._tag).toBe("MissingEnvError");
    expect(err.names).toEqual(["POSTUI_TOKEN_A", "POSTUI_TOKEN_B"]);
    expect(err.message).toContain("POSTUI_TOKEN_A");
    expect(err.message).toContain("POSTUI_TOKEN_B");
  });

  test("collects names from url, headers, raw body, form values, and file paths", () => {
    const names = collectEnvNames({
      url: "https://$HOST/v1?token=$QUERY_TOKEN",
      headers: { authorization: "Bearer $T" },
      body: [
        { name: "field", value: "$FIELD_T" },
        { name: "doc", file: "./$DIR/file.json" },
      ],
    });
    expect(names).toEqual(["HOST", "QUERY_TOKEN", "T", "FIELD_T", "DIR"]);
  });
});

// ---------------------------------------------------------------------------
// redaction primitives
// ---------------------------------------------------------------------------

describe("header redaction", () => {
  test("credential-bearing headers are recognized exactly and by over-broad match", () => {
    for (const name of [
      "Authorization",
      "proxy-authorization",
      "Cookie",
      "Set-Cookie",
      "X-Api-Key",
      "X-App-Auth-Token",
      "Session-Id",
    ]) {
      expect(isCredentialHeader(name)).toBe(true);
    }
    for (const name of ["content-type", "accept", "x-request-id", "user-agent"]) {
      expect(isCredentialHeader(name)).toBe(false);
    }
  });

  test("redactHeaders replaces only credential values with the fixed marker", () => {
    expect(
      redactHeaders([
        ["Authorization", `Bearer ${CANARY}`],
        ["content-type", "application/json"],
      ]),
    ).toEqual([
      ["Authorization", REDACTED],
      ["content-type", "application/json"],
    ]);
  });
});

describe("secret scrubbing", () => {
  test("removes every occurrence of every secret", () => {
    expect(scrubSecrets(`x ${CANARY} x ${CANARY}`, [CANARY])).toBe(`x ${REDACTED} x ${REDACTED}`);
  });

  test("longest secret wins so a prefix cannot leave a tail", () => {
    expect(scrubSecrets("abcd", ["abc", "abcd"])).toBe(REDACTED);
  });

  test("empty secrets are skipped and scrubbing is idempotent", () => {
    const once = scrubSecrets("keep", ["", "missing"]);
    expect(once).toBe("keep");
    expect(scrubSecrets(once, ["keep"])).toBe(REDACTED);
  });
});
