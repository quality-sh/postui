import { afterAll, describe, expect, test } from "bun:test";
import { prettyBody } from "../src/tui/composer-body.ts";
import { focusComposer, HEIGHT, moduleSource, openFirstRequest, setupApp, teardownApps } from "./helpers/tui-app.ts";
import { frameText, rowContaining } from "./helpers/tui-capture.ts";

afterAll(async () => {
  await teardownApps();
});

describe("prettyBody", () => {
  test("lays a one-line JSON body out over lines, two-space indent", () => {
    expect(prettyBody('{"title":"hi","tags":["a","b"],"meta":{}}')).toBe(
      '{\n  "title": "hi",\n  "tags": [\n    "a",\n    "b"\n  ],\n  "meta": {}\n}',
    );
  });

  test("keeps every token exactly as written: no number is re-printed", () => {
    const pretty = prettyBody('{"price":1.0,"id":12345678901234567890,"e":1e3}');
    expect(pretty).toContain('"price": 1.0');
    expect(pretty).toContain('"id": 12345678901234567890');
    expect(pretty).toContain('"e": 1e3');
  });

  test("leaves alone what it should not touch", () => {
    expect(prettyBody("name=ada&role=engineer")).toBeNull(); // not JSON
    expect(prettyBody('{"a":1')).toBeNull(); // incomplete
    expect(prettyBody('{\n  "a": 1\n}')).toBeNull(); // already laid out by its author
    expect(prettyBody("{}")).toBeNull(); // nothing to lay out
  });
});

describe("the composer shows JSON bodies pretty", () => {
  test("a saved one-line JSON body opens laid out, and does not count as an edit", async () => {
    const app = await setupApp({
      "create.ts": moduleSource("POST", "http://never-reached.test/posts", {
        body: '{"title":"hello","userId":1}',
      }),
    });
    await openFirstRequest(app);
    await focusComposer(app);
    expect(rowContaining(app, '"title": "hello",')).not.toBeNull();
    expect(rowContaining(app, '"userId": 1')).not.toBeNull();
    expect(frameText(app, HEIGHT)).not.toContain('{"title":"hello"');
    expect(app.shell.composer.edited).toBe(false); // no unsaved dot for a view change
  });
});
