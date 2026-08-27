export class ShellSyntaxError extends Error {}

/**
 * Split a POSIX shell command string into words, honoring single quotes,
 * double quotes, backslash escapes, and backslash line continuations.
 *
 * "curl -X POST 'https://x.io/api?log=1\\n'" → ["curl", "-X", "POST", ...]
 */
export function splitShell(input: string): string[] {
  const words: string[] = [];
  let current = "";
  let building = false;
  let i = 0;

  const endWord = () => {
    if (building) {
      words.push(current);
      current = "";
      building = false;
    }
  };

  while (i < input.length) {
    const ch = input[i];
    if (ch === undefined) break;

    if (ch === "'") {
      building = true;
      const close = input.indexOf("'", i + 1);
      if (close === -1) throw new ShellSyntaxError("unterminated single quote");
      current += input.slice(i + 1, close);
      i = close + 1;
    } else if (ch === '"') {
      building = true;
      const quoted = readDoubleQuoted(input, i + 1, current);
      current = quoted.text;
      i = quoted.end;
    } else if (ch === "\\" && i + 1 < input.length) {
      if (input[i + 1] === "\n") {
        i += 2; // line continuation
        continue;
      }
      building = true;
      current += input[i + 1];
      i += 2;
    } else if (ch === " " || ch === "\t" || ch === "\n") {
      endWord();
      i++;
    } else {
      building = true;
      current += ch;
      i++;
    }
  }

  endWord();
  return words;
}

/**
 * Scan the inside of a double-quoted string starting after the opening quote.
 * Only `\` escapes the next character, and only when it escapes `"` or `\`.
 */
function readDoubleQuoted(
  input: string,
  start: number,
  prefix: string,
): { text: string; end: number } {
  let current = prefix;
  let i = start;

  for (;;) {
    if (i >= input.length) throw new ShellSyntaxError("unterminated double quote");
    const c = input[i];
    if (c === undefined) throw new ShellSyntaxError("unterminated double quote");
    if (c === '"') {
      return { text: current, end: i + 1 };
    }
    const next = input[i + 1];
    if (c === "\\" && next !== undefined && (next === '"' || next === "\\")) {
      current += next;
      i += 2;
    } else {
      current += c;
      i++;
    }
  }
}
