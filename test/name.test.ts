import { describe, expect, test } from "bun:test";
import { resolveModuleName, SaveNameError } from "../src/save/name.ts";

function url(raw: string): URL {
  return new URL(raw);
}

describe("resolveModuleName", () => {
  test("--name flag wins over the URL", () => {
    const name = resolveModuleName({ flag: "employees", url: url("https://api.dev/users") });
    expect(name).toBe("employees");
  });

  test("derives the name from the last URL path segment", () => {
    const name = resolveModuleName({ flag: null, url: url("https://api.dev/users") });
    expect(name).toBe("users");
  });

  test("ignores the query string when deriving", () => {
    const name = resolveModuleName({ flag: null, url: url("https://api.dev/users?page=2") });
    expect(name).toBe("users");
  });

  test("trailing slash falls back to the last non-empty segment", () => {
    const name = resolveModuleName({ flag: null, url: url("https://api.dev/users/") });
    expect(name).toBe("users");
  });

  test("root path falls back to the hostname", () => {
    const name = resolveModuleName({ flag: null, url: url("https://api.dev/") });
    expect(name).toBe("api.dev");
  });

  test("strips a .ts suffix from --name", () => {
    const name = resolveModuleName({ flag: "users.ts", url: url("https://api.dev/other") });
    expect(name).toBe("users");
  });

  test("rejects a path-traversal name", () => {
    expect(() => resolveModuleName({ flag: "../evil", url: url("https://api.dev/x") })).toThrow(
      SaveNameError,
    );
  });

  test("rejects an empty --name", () => {
    expect(() => resolveModuleName({ flag: "", url: url("https://api.dev/x") })).toThrow(
      SaveNameError,
    );
  });

  test("rejects a name with a slash", () => {
    expect(() => resolveModuleName({ flag: "a/b", url: url("https://api.dev/x") })).toThrow(
      SaveNameError,
    );
  });

  test("rejects a derived segment that is not a safe module name", () => {
    expect(() =>
      resolveModuleName({ flag: null, url: url("https://api.dev/users%20list") }),
    ).toThrow(SaveNameError);
  });

  test("the error names the offending name", () => {
    try {
      resolveModuleName({ flag: "../evil", url: url("https://api.dev/x") });
      throw new Error("expected SaveNameError");
    } catch (e) {
      if (!(e instanceof SaveNameError)) throw e;
      expect(e.message).toContain("../evil");
    }
  });
});
