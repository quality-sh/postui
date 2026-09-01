import { describe, expect, test } from "bun:test";
import { generateDocs } from "../src/docs/docs.ts";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "postui-docs-render-"));
}

/** A postui-emitted `export const request` module at requests/<name>.ts. */
async function save(dir: string, name: string, spec: Record<string, unknown>): Promise<void> {
  await mkdir(join(dir, "requests"), { recursive: true });
  await writeFile(
    join(dir, "requests", `${name}.ts`),
    `// Saved by postui — this file is the request; edit it freely.\n` +
      `export const request = ${JSON.stringify(spec, null, 2)};\n`,
  );
}

async function doc(root: string): Promise<string> {
  return await readFile(join(root, "docs", "API.md"), "utf8");
}

describe("generateDocs — credential safety", () => {
  test("credential header values are never shown; $ENV refs are shown as names, never resolved", async () => {
    const dir = await scratch();
    try {
      await save(dir, "users", {
        method: "GET",
        url: "https://api.dev/users",
        headers: {
          Authorization: "Bearer $AUTH_TOKEN",
          "X-Api-Key": "$KEY",
          "X-Request-Id": "$REQ_ID",
          "X-Braced": "${BRACED_ID}",
          Accept: "application/json",
        },
        body: null,
      });
      const prev = {
        AUTH_TOKEN: process.env.AUTH_TOKEN,
        KEY: process.env.KEY,
        REQ_ID: process.env.REQ_ID,
        BRACED_ID: process.env.BRACED_ID,
      };
      process.env.AUTH_TOKEN = "live-secret-1";
      process.env.KEY = "live-secret-2";
      process.env.REQ_ID = "live-value-3";
      process.env.BRACED_ID = "live-value-4";
      try {
        await generateDocs({ root: dir });
      } finally {
        for (const [name, value] of Object.entries(prev)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }

      const text = await doc(dir);
      expect(text).toContain("Authorization: [redacted]");
      expect(text).toContain("X-Api-Key: [redacted]");
      expect(text).toContain("X-Request-Id: requires REQ_ID env");
      expect(text).toContain("X-Braced: requires BRACED_ID env");
      expect(text).toContain("Accept: application/json");
      // No resolved value ever reaches the document — docs reads no env.
      expect(text).not.toContain("live-secret-1");
      expect(text).not.toContain("live-secret-2");
      expect(text).not.toContain("live-value-3");
      expect(text).not.toContain("live-value-4");
      expect(text).not.toContain("Bearer");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("form values follow the same rule: marker-named fields withheld, $ENV as name, files shown", async () => {
    const dir = await scratch();
    try {
      await save(dir, "profile", {
        method: "POST",
        url: "https://api.dev/profile",
        headers: {},
        body: [
          { name: "password", value: "hunter2" },
          { name: "city", value: "Springfield" },
          { name: "avatar", file: "./avatar.png" },
          { name: "trace", value: "$TRACE_ID" },
        ],
      });

      await generateDocs({ root: dir });

      const text = await doc(dir);
      expect(text).toContain("- password: [redacted]");
      expect(text).toContain("- city: Springfield");
      expect(text).toContain("- avatar (file): ./avatar.png");
      expect(text).toContain("- trace: requires TRACE_ID env");
      expect(text).not.toContain("hunter2");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("generateDocs — body shapes and content fidelity", () => {
  test("none, raw string, and form bodies are all described", async () => {
    const dir = await scratch();
    try {
      await save(dir, "b-none", { method: "GET", url: "https://api.dev/a", headers: {}, body: null });
      await save(dir, "b-raw", {
        method: "POST",
        url: "https://api.dev/b",
        headers: {},
        body: '{"name":"ben"}',
      });
      await save(dir, "b-form", {
        method: "PUT",
        url: "https://api.dev/c",
        headers: {},
        body: [{ name: "color", value: "blue" }],
      });

      await generateDocs({ root: dir });

      // Sections appear in folder order: b-form, b-none, b-raw.
      const text = await doc(dir);
      const section = (name: string, next: string | null): string => {
        const start = text.indexOf(`## ${name}`);
        if (next === null) return text.slice(start);
        return text.slice(start, text.indexOf(`## ${next}`));
      };
      const none = section("b-none", "b-raw");
      expect(none).toContain("### body");
      expect(none).toContain("none");

      const form = section("b-form", "b-none");
      expect(form).toContain("- color: blue");

      expect(section("b-raw", null)).toContain('{"name":"ben"}');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("unicode in url, headers, and body round-trips verbatim", async () => {
    const dir = await scratch();
    try {
      await save(dir, "cafe", {
        method: "GET",
        url: "https://api.dev/café/书面",
        headers: { "X-Note": "café ☕" },
        body: '{"greeting":"héllo 🌍"}',
      });

      await generateDocs({ root: dir });

      const text = await doc(dir);
      expect(text).toContain("- url: https://api.dev/café/书面");
      expect(text).toContain("- X-Note: café ☕");
      expect(text).toContain("héllo 🌍");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a body of backticks cannot break out of its code fence", async () => {
    const dir = await scratch();
    try {
      const body = "```js\ncode();\n```";
      await save(dir, "snippet", {
        method: "POST",
        url: "https://api.dev/snapshot",
        headers: {},
        body,
      });

      await generateDocs({ root: dir });

      const text = await doc(dir);
      expect(text).toContain("code();");
      expect(text).toContain("````");
      // The whole body is inside: its own ``` runs never close the outer fence.
      expect(text.split("````").length).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
