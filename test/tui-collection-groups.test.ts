import { describe, expect, test } from "bun:test";
import {
  collectionTitle,
  groupByCollection,
  isMutatingMethod,
} from "../src/tui/collection-groups.ts";

describe("collection grouping and coloring (pure)", () => {
  test("the collection title is the first URL path segment, capitalized like the mockup", () => {
    expect(collectionTitle("https://api.dev/users")).toBe("Users");
    expect(collectionTitle("https://api.dev/users/123/orders")).toBe("Users");
  });

  test("a URL with no path segments groups under its hostname", () => {
    expect(collectionTitle("https://api.dev")).toBe("api.dev");
    expect(collectionTitle("https://api.dev/")).toBe("api.dev");
  });

  test("an unparsable URL groups under an honest marker instead of crashing", () => {
    expect(collectionTitle("not a url")).toBe("(invalid url)");
  });

  test("mutating methods get the accent treatment; safe methods stay muted", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "post"]) {
      expect(isMutatingMethod(method)).toBe(true);
    }
    for (const method of ["GET", "HEAD", "OPTIONS", "get"]) {
      expect(isMutatingMethod(method)).toBe(false);
    }
  });

  test("groupByCollection sorts groups by title and keeps loader order within a group", () => {
    const requests = [
      { name: "users-create", path: "/x/users-create.ts", request: { method: "POST", url: "https://api.dev/users", headers: {}, body: null } },
      { name: "health", path: "/x/health.ts", request: { method: "GET", url: "https://api.dev/health", headers: {}, body: null } },
      { name: "users-list", path: "/x/users-list.ts", request: { method: "GET", url: "https://api.dev/users", headers: {}, body: null } },
    ] as const;
    const groups = groupByCollection([...requests]);
    expect(groups.map(group => group.title)).toEqual(["Health", "Users"]);
    expect(groups[1]?.requests.map(request => request.name)).toEqual(["users-create", "users-list"]);
  });
});
