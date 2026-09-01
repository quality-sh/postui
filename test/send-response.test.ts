import { describe, expect, test } from "bun:test";
import {
  bodyExcerpt,
  captureResponse,
  clip,
  DEFAULT_BODY_WINDOW,
  describeBodyShape,
  MAX_DISPLAY_HEADERS,
} from "../src/send/response.ts";
import {
  BadSendDefinitionError,
  NetworkPathError,
  TransportFailureError,
} from "../src/send/errors.ts";
import { classifyTransportError } from "../src/send/send.ts";
import { REDACTED } from "../src/send/redact.ts";

const CANARY = "agent-secret-91af";

const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;

// ---------------------------------------------------------------------------
// bounded response capture
// ---------------------------------------------------------------------------

describe("body shape and excerpt bounds", () => {
  test("shapes: empty, json object, json array, json scalar, typed text, opaque", () => {
    expect(describeBodyShape(enc(""), null)).toBe("empty");
    expect(describeBodyShape(enc('{"a":1,"b":2}'), "application/json")).toBe("json object with 2 keys");
    expect(describeBodyShape(enc("[1,2,3]"), "application/json")).toBe("json array of 3 items");
    expect(describeBodyShape(enc("42"), "application/json")).toBe("json scalar");
    expect(describeBodyShape(enc("<h1>hi</h1>"), "text/html; charset=utf-8")).toBe("text/html");
    expect(describeBodyShape(enc("just words"), null)).toBe("opaque");
  });

  test("excerpt keeps the window bytes and reports truncation", () => {
    const body = enc("x".repeat(1000));
    expect(bodyExcerpt(body, 10).excerpt).toBe("x".repeat(10));
    expect(bodyExcerpt(body, 10).excerptBytes).toBe(10);
    expect(bodyExcerpt(body, 10).truncated).toBe(true);
    expect(bodyExcerpt(body, 1000).truncated).toBe(false);
    expect(bodyExcerpt(enc(""), 10)).toEqual({ excerpt: "", excerptBytes: 0, truncated: false });
  });

  test("a multi-byte character cut in half does not throw", () => {
    const body = enc("🎉".repeat(100));
    expect(bodyExcerpt(body, 3).excerpt.length).toBeGreaterThan(0);
  });

  test("clip marks long values", () => {
    expect(clip("short", 10)).toBe("short");
    expect(clip("x".repeat(300), 256)).toBe("x".repeat(256) + "…");
  });

  test("capture caps header blocks and redacts credential values", () => {
    const headers = new Headers();
    // Headers iterate in sorted order: "authorization" sorts before the pads,
    // so it survives the cap and must come out redacted.
    headers.set("authorization", CANARY);
    for (let i = 0; i < MAX_DISPLAY_HEADERS + 5; i++) headers.set(`x-pad-${i}`, "v");
    const captured = captureResponse({ status: 200, headers }, enc('{"ok":true}'), DEFAULT_BODY_WINDOW);
    expect(captured.headers.length).toBe(MAX_DISPLAY_HEADERS);
    expect(captured.headersOmitted).toBe(6);
    expect(captured.headers.find(([n]) => n === "authorization")?.[1]).toBe(REDACTED);
    expect(JSON.stringify(captured.headers)).not.toContain(CANARY);
    expect(captured.shape).toBe("json object with 1 keys");
  });
});

// ---------------------------------------------------------------------------
// transport classification (two-tier exit contract)
// ---------------------------------------------------------------------------

describe("transport error classification", () => {
  test("pre-connect causes are misfires (NetworkPathError, exit 2)", () => {
    for (const code of ["ENOTFOUND", "ECONNREFUSED", "ConnectionRefused", "DnsNotFound", "EAI_AGAIN"]) {
      const e = classifyTransportError(
        Object.assign(new TypeError("fetch failed"), { cause: { code } }),
        [],
      );
      expect(e).toBeInstanceOf(NetworkPathError);
    }
  });

  test("TLS handshake failures cannot establish a path (exit 2)", () => {
    const e = classifyTransportError(
      Object.assign(new Error("handshake"), { cause: { code: "CERT_HAS_EXPIRED" } }),
      [],
    );
    expect(e).toBeInstanceOf(NetworkPathError);
  });

  test("everything else happened after the send started (TransportFailureError, exit 1)", () => {
    const e = classifyTransportError(
      Object.assign(new TypeError("terminated"), { cause: { code: "ECONNRESET" } }),
      [],
    );
    expect(e).toBeInstanceOf(TransportFailureError);
    expect(classifyTransportError(new Error("socket closed"), [])).toBeInstanceOf(TransportFailureError);
  });

  test("error messages keep the code and drop secrets", () => {
    const e = classifyTransportError(
      Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }),
      [],
    );
    expect(e.message).toContain("ECONNRESET");
    const secret = classifyTransportError(
      Object.assign(new TypeError(`connect ${CANARY} failed`), { cause: { code: "ECONNRESET" } }),
      [CANARY],
    );
    expect(secret.message).not.toContain(CANARY);
    expect(secret.message).toContain(REDACTED);
  });

  test("a definition error never masquerades as transport", () => {
    // Construction sites outside classify map shape problems to this class.
    expect(new BadSendDefinitionError({ message: "x" })._tag).toBe("BadSendDefinitionError");
  });
});
