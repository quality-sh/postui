/** The full `postui` help text, printed to stderr on usage errors. */
export const USAGE_TEXT = `postui — the terminal postman

Usage:
  postui <curl ...>          Parse a curl command (paste it raw, quotes included)
  postui --json <curl ...>   Emit the structured request as JSON
  postui save [--name <n>] [--force] <curl ...>
                             Save the request as requests/<n>.ts
  postui gen [--framework <f>]
                             Generate tests/<n>.test.ts from saved requests
                             (<f>: vitest | bun:test | node:test; default: detected)
  postui docs [--out <dir>]  Regenerate docs/API.md from saved requests
                             (--out <dir> publishes somewhere else than docs/)
  postui run                 Execute the project's own test command
                             (package.json scripts.test); no built-in runner
  postui send [--json] [--body-bytes <n>] <name>
                             Send saved requests/<name>.ts once, non-interactively.
                             Bounded redacted digest by default (256-byte body
                             excerpt); --body-bytes <n> widens only that window.
                             Exit: 0 sent, 1 API rejected the send, 2 postui
                             could not make the send. Credential values come
                             only from the environment, never from arguments.

Examples:
  postui 'curl -X POST https://api.dev/users -H "Authorization: Bearer $T" -d '{"name":"ben"}''
  postui save 'curl https://api.dev/users'
  postui gen
  postui docs
  postui send users
  postui send users --json --body-bytes 4096
`;
