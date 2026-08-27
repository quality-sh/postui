# postui — project brief

> The terminal postman. Delivers requests. Doesn't judge.

## What it is

A CLI/TUI tool that turns curl commands into structured TypeScript requests
saved in your repo. From that one workspace, three consumers are served:

1. **You** — parse and display any curl (`postui <curl>`)
2. **Your tests** — generate integration tests for whichever framework you use
3. **Your agents** — a safe CLI surface that hits APIs without leaking tokens
   or clogging context

The pitch: *describe your API once by hitting it like a human; your tests, your
agent, and your docs all read from the same folder.*

## Why it exists

- Postman-style tools charge seat costs for collection management nobody wants.
  postui's "collection" is a folder of plain TypeScript files.
- AI agents should be first-class API clients. No mainstream tool does this.
  Requests live in files, tokens come from env at send time, and all output
  paths redact credentials.
- Executable TS only. No `.bru`, no YAML DSL, no schema language to maintain.

## Non-goals

- Jest support (deliberate).
- A hosted/cloud layer, team dashboards, or any seat/pricing model.
- An intermediate assertion DSL — emit raw idiomatic test code per framework.
- Windows-first anything. Bun + POSIX is the floor.

## Key decisions (and why)

| Decision | Choice | Rationale |
|---|---|---|
| Runtime | Bun 1.4 | TUI + single binary + TS native |
| Errors/validation | Effect 3.22.1 (stable) | `Data.TaggedError` + `Schema`-validated JSON output. v4 is at RC; revisit when stable. |
| Package name | `@quality-sh/postui` | Bare `postui` blocked by npm typosquat protection (`post-ui` exists). Scoped bin still installs as `postui`. |
| Test targets | vitest, bun:test, node:test first | Same shape; one small emitter each. `@playwright/test` later (its `request` fixture is an outlier worth real support). Playwright-as-library runs fine under Bun. |
| Publishing | OIDC trusted publishing | `release.yml` on `v*` tags, `id-token: write`, `npm` environment gate, org staged-publishing as final approval. No long-lived tokens anywhere. |
| License | MIT | |

## Current state (v0.0.1 published, v0.0.2 staged)

Module one is done: **curl → structured request**.

- `src/curl/shell.ts` — POSIX word splitter (quotes, escapes, line continuations)
- `src/curl/parse.ts` — flag parser: `-X -H -d --data-raw -F -u --url`, ignored-flag
  warnings, unknown-flag errors, method inference (body → POST)
- `src/types.ts` — `RequestSpec` (method/url/headers/body)
- `src/schema.ts` — Effect Schema contract for serialized output
- `src/format.ts` — pretty terminal display
- `src/cli.ts` — entry: `postui <curl>` (pretty), `postui --json <curl>` (validated JSON)
- `test/curl.test.ts` — 17 tests, all green; `bun test` + `tsc --noEmit` both pass

## Roadmap

1. `postui save <curl>` → writes `requests/<name>.ts` into the workspace
2. `postui gen` → emits test files for vitest / bun:test / node:test
   (detect from `package.json`, override via flag)
3. `postui run [--json]` → execs the user's test command; structured,
   redacted output for agents; composable request chaining
4. OpenTUI interactive browser over the workspace (the "Postman" part,
   deliberately last)

The biggest engineering risk lives in curl parsing edge cases — budget real
time there.

## Ops notes for whoever inherits this

- Releases: push tag `v0.0.2`-style → GitHub Actions → npm (staged) → approve.
- Trusted publisher must point at `quality-sh/postui`, workflow `release.yml`,
  environment `npm` (one-time config on the npm package settings page).
- Git identity gotcha: `~/.config/git/config` maps `gitdir:/home/ben/work/` to
  the work identity. Keep this repo outside `~/work` (it lives in `~/repos`).
- The npm package embeds a bundled `dist/postui.js` (bin) plus raw `src/`.
  `prepublishOnly` rebuilds; don't commit `dist/` changes by hand.
