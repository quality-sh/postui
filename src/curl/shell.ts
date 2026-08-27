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
    const ch = input[i]!;

    if (ch === "'") {
      building = true;
      const close = input.indexOf("'", i + 1);
      if (close === -1) throw new ShellSyntaxError("unterminated single quote");
      current += input.slice(i + 1, close);
      i = close + 1;
    } else if (ch === '"') {
      building = true;
      i++;
      for (;;) {
        if (i >= input.length) throw new ShellSyntaxError("unterminated double quote");
        const c = input[i]!;
        if (c === '"') {
          i++;
          break;
        }
        // Inside double quotes only \ escapes the next char.
        if (c === "\\" && i + 1 < input.length && (input[i + 1] === '"' || input[i + 1] === "\\")) {
          current += input[i + 1]!;
          i += 2;
        } else {
          current += c;
          i++;
        }
      }
    } else if (ch === "\\" && i + 1 < input.length) {
      if (input[i + 1] === "\n") {
        i += 2; // line continuation
        continue;
      }
      building = true;
      current += input[i + 1]!;
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
