import { tokenize } from "./llama.ts";

function capitalizeFirstLetter(s: string): string {
  const i = s.search(/[a-z]/i);
  if (i < 0) return s;
  return s.slice(0, i) + s[i]!.toUpperCase() + s.slice(i + 1);
}

/**
 * An option is a canonical string; the model may render it with a leading
 * separator space (the tokenizer folds preceding whitespace into the first
 * token) or different casing. These are *renderings of one option*, not
 * separate options — so their masses are summed into the same option.
 */
export function surfaceForms(option: string, includeCaseVariants = true): string[] {
  const base = [option];
  if (includeCaseVariants) {
    const cap = capitalizeFirstLetter(option);
    if (cap !== option) base.push(cap);
  }
  const out = new Set<string>();
  for (const v of base) {
    if (v.startsWith(" ")) {
      out.add(v);
      out.add(v.slice(1));
    } else {
      out.add(v);
      out.add(" " + v);
    }
  }
  return [...out];
}

const tokCache = new Map<string, number[]>();

/** `/tokenize` with an in-process cache. Tokenisation is not a forward pass. */
export async function cachedTokenize(s: string): Promise<number[]> {
  let ids = tokCache.get(s);
  if (!ids) {
    ids = await tokenize(s);
    tokCache.set(s, ids);
  }
  return ids;
}

export interface OptionPath {
  option: string;
  optionIdx: number;
  /** Distinct token paths that render this option. */
  paths: number[][];
}

/** Token paths for every surface rendering of every option. */
export async function buildOptionPaths(
  options: string[],
  includeCaseVariants = true,
): Promise<OptionPath[]> {
  const out: OptionPath[] = [];
  for (let i = 0; i < options.length; i++) {
    const seen = new Set<string>();
    const paths: number[][] = [];
    for (const form of surfaceForms(options[i]!, includeCaseVariants)) {
      const ids = await cachedTokenize(form);
      const key = ids.join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      paths.push(ids);
    }
    out.push({ option: options[i]!, optionIdx: i, paths });
  }
  return out;
}

export interface TokenPath {
  optionIdx: number;
  tokens: number[];
}

export function flattenPaths(optionPaths: OptionPath[]): TokenPath[] {
  const flat: TokenPath[] = [];
  for (const op of optionPaths) {
    for (const tokens of op.paths) flat.push({ optionIdx: op.optionIdx, tokens });
  }
  return flat;
}

export interface TrieNode {
  children: Map<number, TrieNode>;
  /** Option indices with at least one rendering passing through this node. */
  options: Set<number>;
}

export function buildTrie(paths: TokenPath[]): TrieNode {
  const root: TrieNode = { children: new Map(), options: new Set() };
  for (const { optionIdx, tokens } of paths) {
    let node = root;
    for (const t of tokens) {
      let child = node.children.get(t);
      if (!child) {
        child = { children: new Map(), options: new Set() };
        node.children.set(t, child);
      }
      node = child;
      node.options.add(optionIdx);
    }
  }
  return root;
}

/** True if one option's token path is a strict prefix of a *different* option's. */
export function hasCrossOptionPrefix(paths: TokenPath[]): boolean {
  for (const a of paths) {
    for (const b of paths) {
      if (a.optionIdx === b.optionIdx) continue;
      if (a.tokens.length >= b.tokens.length) continue;
      if (a.tokens.every((t, i) => t === b.tokens[i])) return true;
    }
  }
  return false;
}

/** Option index whose path exactly equals `tokens`, or -1. */
export function matchOptionPath(optionPaths: OptionPath[], tokens: number[]): number {
  for (const op of optionPaths) {
    for (const path of op.paths) {
      if (path.length !== tokens.length) continue;
      if (path.every((t, i) => t === tokens[i])) return op.optionIdx;
    }
  }
  return -1;
}
