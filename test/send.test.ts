import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sendRequest } from "../src/send/send.ts";
import {
  BadSendDefinitionError,
  MissingEnvError,
  NetworkPathError,
  SendRejectedError,
  TransportFailureError,
} from "../src/send/errors.ts";
import { REDACTED } from "../src/send/redact.ts";

const CANARY = "agent-secret-91af";

// The send lifecycle: what kind of outcome each situation produces, and
// what has (not) happened on the network when it does. Bounded output
// rendering lives in test/send-output.test.ts.

interface SeenRequest {
  method: string;
  headers: Headers;
  body: string;
}

/** A local HTTP server that records every request it receives. */
function serve(handler: (req: Request, body: string) => Response | Promise<Response>) {
  const seen: SeenRequest[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = await req.text();
      seen.push({ method: req.method, headers: req.headers, body });
      return handler(req, body);
    },
  });
  return {
    url: (path = "/"): string => `http://127.0.0.1:${server.port}${path}`,
    seen,
    close: () => server.stop(true),
  };
}

/**
 * A raw TCP observer: counts connections and parsed request lines but never
 * responds. Used to prove a failing send performs zero network I/O.
 */
function observingServer() {
  let connections = 0;
  let requests = 0;
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open() {
        connections++;
      },
      data(_socket, chunk: Uint8Array) {
        requests += Buffer.from(chunk).toString("latin1").split("HTTP/1").length - 1;
      },
    },
  });
  return {
    port: server.port,
    get connections() {
      return connections;
    },
    get requests() {
      return requests;
    },
    close: () => server.stop(true),
  };
}

/** A server that accepts the request and closes without ever responding. */
function silentServer() {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket) {
        socket.end();
      },
    },
  });
  return { url: `http://127.0.0.1:${server.port}/hooked`, close: () => server.stop(true) };
}

let dir: string;
let cwd: string;

/** Write a saved request module exactly in the shape `postui save` emits. */
async function saveModule(name: string, spec: Record<string, unknown>): Promise<void> {
  await mkdir(join(dir, "requests"), { recursive: true });
  await writeFile(
    join(dir, "requests", `${name}.ts`),
    `// Saved by postui — this file is the request; edit it freely.\n` +
      `export const request = ${JSON.stringify(spec, null, 2)};\n`,
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "postui-send-"));
  cwd = process.cwd();
  process.chdir(dir);
});

afterEach(async () => {
  process.chdir(cwd);
  delete process.env.POSTUI_TEST_TOKEN;
  delete process.env.POSTUI_TOKEN_A;
  delete process.env.POSTUI_TOKEN_B;
  await rm(dir, { recursive: true, force: true });
});

describe("sendRequest lifecycle", () => {
  test("a 2xx send resolves to kind sent with the response captured", async () => {
    const server = serve(() => new Response('{"ok":true}', { status: 200 }));
    await saveModule("users", { method: "GET", url: server.url("/users"), headers: { accept: "application/json" }, body: null });
    const { outcome } = await sendRequest({ name: "users" });
    expect(outcome.kind).toBe("sent");
    expect(outcome.status).toBe(200);
    expect(outcome.response.size).toBe(11);
    server.close();
  });

  test("a non-2xx response is a rejection carrying the named error", async () => {
    const server = serve(() => new Response('{"error":"nope"}', { status: 401 }));
    await saveModule("users", { method: "GET", url: server.url("/"), headers: {}, body: null });
    const { outcome } = await sendRequest({ name: "users" });
    expect(outcome.kind).toBe("rejected");
    expect(outcome.error).toBeInstanceOf(SendRejectedError);
    expect(outcome.error?._tag).toBe("SendRejectedError");
    server.close();
  });

  test("unset names fail before any network I/O, naming every missing name", async () => {
    const observer = observingServer();
    await saveModule("guarded", {
      method: "GET",
      url: `http://127.0.0.1:${observer.port}/hooked`,
      headers: { authorization: "Bearer $POSTUI_TOKEN_A", "x-key": "$POSTUI_TOKEN_B" },
      body: null,
    });
    let thrown: unknown;
    try {
      await sendRequest({ name: "guarded" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(MissingEnvError);
    expect((thrown as MissingEnvError).names).toEqual(["POSTUI_TOKEN_A", "POSTUI_TOKEN_B"]);
    expect(observer.connections).toBe(0);
    expect(observer.requests).toBe(0);
    observer.close();
  });

  test("an unknown saved request is a named misfire", async () => {
    let thrown: unknown;
    try {
      await sendRequest({ name: "ghost" });
    } catch (e) {
      thrown = e;
    }
    expect((thrown as { _tag: string })._tag).toBe("UnknownRequestError");
  });

  test("a name that escapes the requests folder is not a request", async () => {
    let thrown: unknown;
    try {
      await sendRequest({ name: "../evil" });
    } catch (e) {
      thrown = e;
    }
    expect((thrown as { _tag: string })._tag).toBe("UnknownRequestError");
  });

  test("an unparseable url is a definition misfire before any I/O", async () => {
    await saveModule("broken", { method: "GET", url: "not a url", headers: {}, body: null });
    let thrown: unknown;
    try {
      await sendRequest({ name: "broken" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadSendDefinitionError);
  });

  test("a definition error never echoes a resolved env value", async () => {
    // A schemeless URL cannot parse once $HOST is substituted; the message
    // names the bad URL but must scrub the substituted value.
    process.env.POSTUI_TEST_TOKEN = CANARY;
    await saveModule("schemeful", {
      method: "GET",
      url: "$POSTUI_TEST_TOKEN.example/api",
      headers: {},
      body: null,
    });
    let thrown: unknown;
    try {
      await sendRequest({ name: "schemeful" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadSendDefinitionError);
    expect((thrown as BadSendDefinitionError).message).not.toContain(CANARY);
    expect((thrown as BadSendDefinitionError).message).toContain(REDACTED);

    // same for an unreadable form file whose path carries a substituted value
    await saveModule("formfile", {
      method: "POST",
      url: "https://api.dev/upload",
      headers: {},
      body: [{ name: "doc", file: "./$POSTUI_TEST_TOKEN/missing.json" }],
    });
    let thrown2: unknown;
    try {
      await sendRequest({ name: "formfile" });
    } catch (e) {
      thrown2 = e;
    }
    expect(thrown2).toBeInstanceOf(BadSendDefinitionError);
    expect((thrown2 as BadSendDefinitionError).message).not.toContain(CANARY);
    expect((thrown2 as BadSendDefinitionError).message).toContain(REDACTED);
  });

  test("a body on GET is refused before any I/O", async () => {
    const server = serve(() => new Response("never"));
    await saveModule("wrong", { method: "GET", url: server.url("/"), headers: {}, body: "x" });
    let thrown: unknown;
    try {
      await sendRequest({ name: "wrong" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadSendDefinitionError);
    expect(server.seen.length).toBe(0);
    server.close();
  });

  test("a connection refused is a NetworkPathError (exit 2 domain)", async () => {
    const observer = observingServer();
    const port = observer.port;
    observer.close();
    await saveModule("lonely", { method: "GET", url: `http://127.0.0.1:${port}/`, headers: {}, body: null });
    let thrown: unknown;
    try {
      await sendRequest({ name: "lonely" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(NetworkPathError);
  });

  test("a peer reset after the send starts is a TransportFailureError (exit 1 domain)", async () => {
    const server = silentServer();
    await saveModule("cut", { method: "POST", url: server.url, headers: {}, body: "hello" });
    let thrown: unknown;
    try {
      await sendRequest({ name: "cut" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TransportFailureError);
    server.close();
  });
});
