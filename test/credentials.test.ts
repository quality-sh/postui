import { describe, expect, test } from "bun:test";
import { redactCredentialLiterals, hasEnvRef } from "../src/save/credentials.ts";
import type { RequestSpec } from "../src/types.ts";

function specWithHeaders(headers: Array<[string, string]>): RequestSpec {
  return {
    method: "GET",
    url: new URL("https://api.dev/users"),
    headers,
    body: { kind: "none" },
  };
}

describe("hasEnvRef", () => {
  test("detects $NAME references", () =>
    expect(hasEnvRef("Bearer $POSTUI_TEST_TOKEN")).toBe(true));
  test("detects ${NAME} references", () => expect(hasEnvRef("${TOKEN}")).toBe(true));
  test("plain literals have no env ref", () => expect(hasEnvRef("sk-live-abc123")).toBe(false));
  test("a bare $ is not a reference", () => expect(hasEnvRef("cost: 5$ total")).toBe(false));
});

describe("redactCredentialLiterals", () => {
  test("keeps an $NAME reference in an Authorization header verbatim", () => {
    const { spec, redacted } = redactCredentialLiterals(
      specWithHeaders([["Authorization", "Bearer $POSTUI_TEST_TOKEN"]]),
    );
    expect(spec.headers).toEqual([["Authorization", "Bearer $POSTUI_TEST_TOKEN"]]);
    expect(redacted).toEqual([]);
  });

  test("keeps an $NAME reference in URL userinfo verbatim", () => {
    const { spec, redacted } = redactCredentialLiterals({
      ...specWithHeaders([]),
      url: new URL("https://$API_KEY@api.dev/x"),
    });
    expect(spec.url.href).toBe("https://$API_KEY@api.dev/x");
    expect(redacted).toEqual([]);
  });

  test("drops literal URL userinfo and reports it", () => {
    const { spec, redacted } = redactCredentialLiterals({
      ...specWithHeaders([]),
      url: new URL("https://admin:s3cret@api.dev/x"),
    });
    expect(spec.url.href).toBe("https://api.dev/x");
    expect(redacted).toEqual(["URL userinfo"]);
  });

  test("drops a bare userinfo username (key-in-URL pattern)", () => {
    const { spec, redacted } = redactCredentialLiterals({
      ...specWithHeaders([]),
      url: new URL("https://apikey123@api.dev/x"),
    });
    expect(spec.url.href).toBe("https://api.dev/x");
    expect(redacted).toEqual(["URL userinfo"]);
  });

  test("strips a literal bearer token and reports the header", () => {
    const { spec, redacted } = redactCredentialLiterals(
      specWithHeaders([["Authorization", "Bearer sk-live-abc123"]]),
    );
    expect(spec.headers).toEqual([["Authorization", ""]]);
    expect(redacted).toEqual(["Authorization header"]);
  });

  test("strips a basic-auth literal from -u", () => {
    const basic = `Basic ${btoa("admin:s3cret")}`;
    const { spec, redacted } = redactCredentialLiterals(
      specWithHeaders([["Authorization", basic]]),
    );
    expect(spec.headers).toEqual([["Authorization", ""]]);
    expect(redacted).toEqual(["Authorization header"]);
  });

  test("covers proxy-authorization", () => {
    const { redacted } = redactCredentialLiterals(
      specWithHeaders([["Proxy-Authorization", "Basic dXNlcjpwYXNz"]]),
    );
    expect(redacted).toEqual(["Proxy-Authorization header"]);
  });

  test("matches header names case-insensitively and preserves their casing", () => {
    const { spec, redacted } = redactCredentialLiterals(
      specWithHeaders([["authorization", "Bearer sk-live-abc123"]]),
    );
    expect(redacted).toEqual(["authorization header"]);
    expect(spec.headers).toEqual([["authorization", ""]]);
  });

  test("leaves non-authorization headers alone", () => {
    const { spec, redacted } = redactCredentialLiterals(
      specWithHeaders([
        ["X-Api-Key", "plain-literal-key"],
        ["Content-Type", "application/json"],
      ]),
    );
    expect(redacted).toEqual([]);
    expect(spec.headers).toEqual([
      ["X-Api-Key", "plain-literal-key"],
      ["Content-Type", "application/json"],
    ]);
  });

  test("does not mutate the input spec", () => {
    const original = specWithHeaders([["Authorization", "Bearer sk-live-abc123"]]);
    redactCredentialLiterals(original);
    expect(original.headers).toEqual([["Authorization", "Bearer sk-live-abc123"]]);
  });
});
