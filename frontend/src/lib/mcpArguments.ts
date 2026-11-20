/** Format simple args as a command line. JSON preserves every character of complex values. */
export function formatMcpArguments(args: string[]): string {
  return args.every(arg => /^[\w@./:=+-]+$/u.test(arg)) ? args.join(" ") : JSON.stringify(args);
}

/** Parse the short form without variable expansion or shell execution. */
export function splitMcpWords(text: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let quote = "";
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (!quote && /\s/u.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
      continue;
    }
    started = true;
    const next = text[i + 1];
    // Backslashes in unquoted Windows paths are literal unless they escape a separator or quote.
    const escapesOutsideQuotes = !quote && (next === "'" || next === '"' || (next && /\s/u.test(next)));
    const escapesInsideDoubleQuotes = quote === '"' && (next === '"' || next === "\\");
    if (char === "\\" && (escapesOutsideQuotes || escapesInsideDoubleQuotes)) {
      word += next;
      i++;
    } else if (char === quote) {
      quote = "";
    } else if (!quote && (char === "'" || char === '"')) {
      quote = char;
    } else {
      word += char;
    }
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
}

export function parseMcpArguments(text: string): string[] | null {
  if (!text.trimStart().startsWith("[")) return splitMcpWords(text);
  try {
    const values: unknown = JSON.parse(text);
    return Array.isArray(values) && values.every(value => typeof value === "string") ? values : null;
  } catch {
    return null;
  }
}
