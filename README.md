# postui

> The terminal postman. Delivers requests. Doesn't judge.

`postui` parses curl commands into structured requests saved as plain
TypeScript. From that one workspace you get integration tests for your own test
framework and a safe CLI surface agents can call — no tokens leaked into context.

## Status

Pre-alpha. Module one of the plan: **curl → structured request**.

```sh
bun postui/src/cli.ts \
  'curl -X POST https://api.dev/users -H "Authorization: Bearer $T" -d "{\"name\":\"ben\"}"'
```

## Plan

1. `postui <curl>` → parse + pretty display ✅ (this)
2. `postui save <curl>` → writes `requests/<name>.ts` into the workspace ✅
3. `postui gen` → emits tests for vitest / bun:test / node:test ✅
4. `postui run` → executes your project's own test command ✅
5. `postui send <name> [--json] [--body-bytes <n>]` → sends one saved request
   for agents: one shot, bounded redacted output, exit 0/1/2 retry signal ✅
6. `postui docs [--out <dir>]` → regenerates markdown API docs (default
   `docs/API.md`) from the saved requests alone ✅
7. OpenTUI interactive browser over the workspace

## License

MIT
