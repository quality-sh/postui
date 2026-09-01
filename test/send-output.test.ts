import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderDigest, renderJson, sendRequest } from "../src/send/send.ts";
import { REDACTED } from "../src/send/redact.ts";

// Bounded, redacted output rendering, exercised end to end against a local
// server: the default digest, the explicit --body-bytes window, credential
// header redaction, and env-value scrubbing on every view.

const CANARY = "agent-secret-91af";

function serve(handler: (req: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, fetch: handler });
  return { url: (path = "/"): string => `http://127.0.0.1:${server.port}${path}`, close: () => server.stop(true) };
}

let dir: string;
let cwd: string;

async function saveModule(name: string, spec: Record<string, unknown>): Promise<void> {
  await mkdir(join(dir, "requests"), { recursive: true });
  await writeFile(
    join(dir, "requests", `${name}.ts`),
    `// Saved by postui — this file is the request; edit it freely.\n` +
      `export const request = ${JSON.stringify(spec, null, 2)};\n`,
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "postui-send-out-"));
  cwd = process.cwd();
  process.chdir(dir);
});

afterEach(async () => {
  process.chdir(cwd);
  delete process.env.POSTUI_TEST_TOKEN;
  await rm(dir, { recursive: true, force: true });
});

describe("bounded output over a local server", () => {
  test("the default digest carries status, headers, size, shape, excerpt — and the marker", async () => {
    const server = serve(() =>
      new Response(JSON.stringify({ hello: "world", items: [1, 2, 3] }), {
        status: 200,
        headers: { "x-trace-auth": CANARY },
      }),
    );
    await saveModule("hooked", {
      method: "GET",
      url: server.url("/"),
      headers: { authorization: "Bearer $POSTUI_TEST_TOKEN" },
      body: null,
    });
    process.env.POSTUI_TEST_TOKEN = CANARY;
    const { outcome, secrets } = await sendRequest({ name: "hooked" });
    const digest = renderDigest(outcome, secrets);
    expect(digest).toContain("-> 200");
    expect(digest).toContain("request headers:");
    expect(digest).toContain(`authorization: ${REDACTED}`);
    expect(digest).toContain("response headers:");
    expect(digest).toContain(`x-trace-auth: ${REDACTED}`);
    expect(digest).toContain("bytes, json object with 2 keys");
    expect(digest).toContain("body excerpt (");
    expect(digest).not.toContain(CANARY);
    server.close();
  });

  test("credential headers leave the request redacted and the response view too", async () => {
    const server = serve(() => new Response("{}", { status: 200, headers: { "x-trace-auth": CANARY } }));
    await saveModule("hooked", {
      method: "GET",
      url: server.url("/"),
      headers: { authorization: `Bearer ${CANARY}`, "x-api-key": CANARY },
      body: null,
    });
    const { outcome } = await sendRequest({ name: "hooked" });
    expect(outcome.request.headers.find(([n]) => n === "authorization")?.[1]).toBe(REDACTED);
    expect(outcome.request.headers.find(([n]) => n === "x-api-key")?.[1]).toBe(REDACTED);
    expect(outcome.response.headers.find(([n]) => n === "x-trace-auth")?.[1]).toBe(REDACTED);
    expect(JSON.stringify(outcome)).not.toContain(CANARY);
    server.close();
  });

  test("the default window bounds the digest and --body-bytes widens it", async () => {
    const tail = "tail-marker-4f21";
    const big = JSON.stringify({ pad: "x".repeat(5000), tail });
    const server = serve(() => new Response(big, { status: 200 }));
    await saveModule("wide", { method: "GET", url: server.url("/"), headers: {}, body: null });

    const { outcome } = await sendRequest({ name: "wide" });
    const bounded = renderDigest(outcome, []);
    expect(bounded.length).toBeLessThan(4096);
    expect(bounded).toContain(`${big.length} bytes`);
    expect(bounded).toContain("json object with 2 keys");
    expect(bounded).not.toContain(tail);
    expect(outcome.response.truncated).toBe(true);

    const wider = await sendRequest({ name: "wide", bodyWindow: 10000 });
    expect(renderDigest(wider.outcome, [])).toContain(tail);
    server.close();
  });

  test("an empty body digests as empty with no excerpt block", async () => {
    const server = serve(() => new Response("", { status: 204 }));
    await saveModule("silent", { method: "GET", url: server.url("/"), headers: {}, body: null });
    const { outcome } = await sendRequest({ name: "silent" });
    const digest = renderDigest(outcome, []);
    expect(outcome.response.shape).toBe("empty");
    expect(digest).toContain("body: 0 bytes, empty");
    expect(digest).not.toContain("excerpt");
    server.close();
  });

  test("a zero window shows no excerpt and still reports the size", async () => {
    const server = serve(() => new Response("explicitly bounded away", { status: 200 }));
    await saveModule("quiet", { method: "GET", url: server.url("/"), headers: {}, body: null });
    const { outcome } = await sendRequest({ name: "quiet", bodyWindow: 0 });
    expect(outcome.response.excerpt).toBe("");
    expect(outcome.response.truncated).toBe(true);
    const digest = renderDigest(outcome, []);
    expect(digest).toContain("body: 23 bytes");
    expect(digest).not.toContain("explicitly bounded away");
    server.close();
  });

  test("redirects are followed and the digest describes the final response", async () => {
    const final = serve(() => new Response('{"final":true}', { status: 200 }));
    const moved = serve(() => Response.redirect(final.url("/final"), 302));
    await saveModule("moved", { method: "GET", url: moved.url("/old"), headers: {}, body: null });
    const { outcome } = await sendRequest({ name: "moved" });
    expect(outcome.status).toBe(200);
    expect(outcome.redirectedTo).toBe(final.url("/final"));
    expect(renderDigest(outcome, [])).toContain("json object with 1 keys");
    final.close();
    moved.close();
  });

  test("form bodies are sent as multipart and a stale saved content-type is dropped", async () => {
    let receivedContentType: string | null = null;
    let receivedBody = "";
    const server = serve(async req => {
      receivedContentType = req.headers.get("content-type");
      receivedBody = await req.text();
      return new Response("created", { status: 201 });
    });
    await saveModule("upload", {
      method: "POST",
      url: server.url("/upload"),
      headers: { "content-type": "multipart/form-data" },
      body: [{ name: "note", value: "hi" }],
    });
    await sendRequest({ name: "upload" });
    expect(receivedContentType).toMatch(/^multipart\/form-data/);
    expect(receivedBody).toContain("note");
    server.close();
  });

  test("a hand-edited literal credential in a header is redacted without any env", async () => {
    const server = serve(() => new Response("ok", { status: 200 }));
    await saveModule("handedited", {
      method: "GET",
      url: server.url("/"),
      headers: { authorization: "Bearer sk-live-hand-edited" },
      body: null,
    });
    const { outcome, secrets } = await sendRequest({ name: "handedited" });
    expect(secrets).toEqual([]);
    const digest = renderDigest(outcome, secrets);
    expect(digest).toContain(REDACTED);
    expect(digest).not.toContain("sk-live-hand-edited");
    server.close();
  });

  test("an echoed credential value is scrubbed from both render modes", async () => {
    const server = serve(req =>
      new Response(JSON.stringify({ echoed: req.headers.get("authorization") }), { status: 200 }),
    );
    await saveModule("echo", {
      method: "GET",
      url: server.url("/"),
      headers: { authorization: "Bearer $POSTUI_TEST_TOKEN" },
      body: null,
    });
    process.env.POSTUI_TEST_TOKEN = CANARY;
    const { outcome, secrets } = await sendRequest({ name: "echo" });
    expect(secrets).toEqual([CANARY]);
    const all = renderDigest(outcome, secrets) + renderJson(outcome, secrets);
    expect(all).not.toContain(CANARY);
    expect(all).toContain(REDACTED);
    // the requests folder stores the NAME only — never the resolved value
    const saved = await readFile(join(dir, "requests", "echo.ts"), "utf8");
    expect(saved).toContain("$POSTUI_TEST_TOKEN");
    expect(saved).not.toContain(CANARY);
    server.close();
  });
});
