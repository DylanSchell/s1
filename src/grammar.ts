/** Escape a string for use inside a GBNF double-quoted literal. */
export function escapeGbnf(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/** Grammar that admits exactly one literal continuation. */
export function literalGrammar(s: string): string {
  return `root ::= "${escapeGbnf(s)}"`;
}

/** Grammar that admits one of several literal continuations. */
export function alternationGrammar(options: string[]): string {
  const alts = options.map((o) => `"${escapeGbnf(o)}"`).join(" | ");
  return `root ::= ${alts}`;
}

/**
 * GBNF token primitive: matches an exact tokenizer token id.
 * Preferred over the string form, which only works if the text is one token.
 */
export function tokenRef(id: number): string {
  return `<[${id}]>`;
}

/** A token-id sequence as GBNF: `<[1]> <[2]>`. */
export function tokenSequence(ids: number[]): string {
  return ids.map(tokenRef).join(" ");
}

/** Alternation over literal token paths: `<[1]> <[2]> | <[3]>`. */
export function alternationOfPaths(paths: number[][]): string {
  const valid = paths.filter((p) => p.length > 0);
  if (valid.length === 0) throw new Error("alternationOfPaths: no non-empty token paths");
  return valid.map(tokenSequence).join(" | ");
}
