import { describe, expect, test } from "bun:test";
import { fuzzyScore, rankRequests } from "../src/tui/search.ts";
import type { LoadedRequest } from "../src/gen/load.ts";

function requestOf(name: string, method: string, url: string): LoadedRequest {
  return {
    name,
    path: `${name}.ts`,
    request: { method, url, headers: {}, body: null },
  } as unknown as LoadedRequest;
}

describe("fuzzyScore", () => {
  test("an empty query matches everything with a neutral score", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
    expect(fuzzyScore("", "")).toBe(0);
  });

  test("a query whose characters are not in order does not match", () => {
    expect(fuzzyScore("xz", "health")).toBeNull();
    expect(fuzzyScore("users!", "users")).toBeNull(); // longer than the field
  });

  test("case folding: the query matches regardless of case", () => {
    expect(fuzzyScore("USE", "users")).not.toBeNull();
    expect(fuzzyScore("use", "USERS")).not.toBeNull();
  });

  test("prefix and boundary matches outrank scattered ones", () => {
    const prefix = fuzzyScore("use", "users") ?? 0;
    const scattered = fuzzyScore("use", "uabsec") ?? -1;
    expect(scattered).not.toBe(-1); // it matches at all…
    expect(prefix).toBeGreaterThan(scattered); // …but far worse
  });

  test("consecutive runs outrank gappy matches at the same position", () => {
    const run = fuzzyScore("abc", "abc") ?? 0;
    const gappy = fuzzyScore("abc", "axbxc") ?? 0;
    expect(run).toBeGreaterThan(gappy);
  });

  test("unicode text matches across case folding and accents stay distinct", () => {
    expect(fuzzyScore("cr", "créer")).not.toBeNull();
    expect(fuzzyScore("CRÉ", "créer")).not.toBeNull();
    expect(fuzzyScore("re", "créer")).not.toBeNull();
    // astral-plane characters line up by code point, not by surrogate pair
    expect(fuzzyScore("😀x", "a😀bxc")).not.toBeNull();
  });

  test("a pathological haystack stays bounded (alignment starts are capped)", () => {
    const haystack = `a`.repeat(20_000);
    const started = performance.now();
    expect(fuzzyScore("aa", haystack)).not.toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("rankRequests", () => {
  const requests = [
    requestOf("users", "POST", "https://api.dev/users"),
    requestOf("health", "GET", "https://api.dev/health"),
    requestOf("orders", "GET", "https://api.dev/orders"),
  ];

  test("the ticket scenario: /use over users, health, orders leaves users on top", () => {
    const ranked = rankRequests("use", requests);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.name).toBe("users");
  });

  test("search covers name, method, and URL", () => {
    // by method
    expect(rankRequests("post", requests).map(r => r.name)).toEqual(["users"]);
    // by URL fragment (orders only matches on its URL path)
    expect(rankRequests("ord", requests).map(r => r.name)).toEqual(["orders"]);
    // health via url
    expect(rankRequests("hea", requests).map(r => r.name)).toEqual(["health"]);
  });

  test("matches are ranked best first: a name-prefix match beats an inner one", () => {
    const pool = [
      requestOf("list-users", "GET", "https://api.dev/list-users"),
      requestOf("users", "GET", "https://api.dev/users"),
    ];
    const ranked = rankRequests("use", pool);
    expect(ranked[0]?.name).toBe("users");
    expect(ranked[1]?.name).toBe("list-users");
  });

  test("a name match outranks a URL-only match of the same string", () => {
    const pool = [
      requestOf("unrelated", "GET", "https://api.dev/users"),
      requestOf("users", "GET", "https://api.dev/other"),
    ];
    const ranked = rankRequests("users", pool);
    expect(ranked[0]?.name).toBe("users"); // matched as the name
  });

  test("an empty query passes the workspace through unfiltered, in order", () => {
    expect(rankRequests("", requests).map(r => r.name)).toEqual([
      "users",
      "health",
      "orders",
    ]);
  });

  test("equal scores keep workspace order (stable sort)", () => {
    const pool = [
      requestOf("aa-one", "GET", "https://api.dev/x"),
      requestOf("aa-two", "GET", "https://api.dev/y"),
    ];
    expect(rankRequests("aa", pool).map(r => r.name)).toEqual(["aa-one", "aa-two"]);
  });

  test("a very long workspace filters without blowup", () => {
    const pool: LoadedRequest[] = [];
    for (let i = 0; i < 2000; i += 1) {
      pool.push(requestOf(`req-${i}`, "GET", `https://api.dev/item/${i}`));
    }
    const started = performance.now();
    const ranked = rankRequests("req-1999", pool);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(ranked[0]?.name).toBe("req-1999");
  });
});
