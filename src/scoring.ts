import { config } from "./config.ts";
import { completion, detokenize } from "./llama.ts";
import {
  buildOptionPaths,
  buildTrie,
  flattenPaths,
  hasCrossOptionPrefix,
  type OptionPath,
  type TrieNode,
} from "./options.ts";

export type Strategy = "raw" | "trie" | "single-pass";

export interface ScoringResult {
  /** Normalized across the supplied options. */
  probabilities: Record<string, number>;
  /** Unnormalized option mass (coverage / abstain signal). */
  raw: Record<string, number>;
  totalRaw: number;
  strategy: Strategy;
  /** Number of /completion calls made. */
  calls: number;
  /** Deepest trie level reached (0 = root only). */
  maxDepth: number;
  /** Required tokens that fell outside the returned top-N. */
  missedTokens: number;
}

export interface ScoreOptionsConfig {
  /** n_probs / top-N requested for each distribution read. */
  nProbs?: number;
  includeCaseVariants?: boolean;
}

async function rawDistribution(prompt: string, nProbs: number): Promise<Map<number, number>> {
  const res = await completion({ prompt, n_predict: 1, n_probs: nProbs });
  const tok = res.completion_probabilities?.[0];
  const dist = new Map<number, number>();
  for (const p of tok?.top_logprobs ?? []) dist.set(p.id, Math.exp(p.logprob));
  return dist;
}

/**
 * Score options with the fewest forward passes:
 *
 *  - one `/completion` at the root yields the raw next-token distribution;
 *  - an option whose trie node belongs to exactly one option is committed there
 *    (its probability is the mass of the shortest prefix that identifies it),
 *    which is length-neutral and avoids penalising multi-word options;
 *  - a *second* call is made only at nodes where two or more options share a
 *    token, by appending that shared prefix to the prompt and re-reading.
 *
 * Calls = 1 + (number of shared-prefix nodes). Distinct first tokens => 1 call.
 */
export async function scoreOptions(
  basePrompt: string,
  options: string[],
  cfg: ScoreOptionsConfig = {},
): Promise<ScoringResult> {
  const nProbs = cfg.nProbs ?? config.nProbs;
  const optionPaths: OptionPath[] = await buildOptionPaths(
    options,
    cfg.includeCaseVariants ?? true,
  );
  const flat = flattenPaths(optionPaths);

  if (hasCrossOptionPrefix(flat)) {
    throw new Error(
      "options overlap at a token boundary (one option is a token-prefix of another); " +
        "give them distinct leading tokens",
    );
  }

  const root = buildTrie(flat);
  const raw: Record<string, number> = {};
  for (const o of options) raw[o] = 0;

  let calls = 0;
  let maxDepth = 0;
  let missedTokens = 0;

  const resolve = async (
    node: TrieNode,
    prefixTokens: number[],
    acc: number,
    depth: number,
  ): Promise<void> => {
    calls++;
    if (depth > maxDepth) maxDepth = depth;

    const prefixText = prefixTokens.length === 0 ? "" : await detokenize(prefixTokens);
    const dist = await rawDistribution(basePrompt + prefixText, nProbs);

    for (const [t, child] of node.children) {
      const p = dist.get(t) ?? 0;
      if (p === 0) {
        missedTokens++;
        continue;
      }
      const childAcc = acc * p;
      if (child.options.size === 1) {
        const idx = child.options.values().next().value as number;
        raw[options[idx]!] = (raw[options[idx]!] ?? 0) + childAcc;
      } else {
        await resolve(child, [...prefixTokens, t], childAcc, depth + 1);
      }
    }
  };

  await resolve(root, [], 1, 0);

  let total = 0;
  for (const o of options) total += raw[o]!;
  const probabilities: Record<string, number> = {};
  for (const o of options) {
    probabilities[o] = total > 0 ? raw[o]! / total : 1 / options.length;
  }

  return {
    probabilities,
    raw,
    totalRaw: total,
    strategy: calls > 1 ? "trie" : "raw",
    calls,
    maxDepth,
    missedTokens,
  };
}
