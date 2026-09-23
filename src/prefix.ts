import { config } from "./config.ts";
import { completion } from "./llama.ts";
import { cachedTokenize } from "./options.ts";

/**
 * Longest prefix shared by every token sequence, or 0 when there are fewer
 * than two (nothing to share).
 */
export function commonPrefixLength(all: number[][]): number {
  if (all.length < 2) return 0;
  const first = all[0]!;
  let len = first.length;
  for (let i = 1; i < all.length && len > 0; i++) {
    const other = all[i]!;
    let j = 0;
    while (j < len && j < other.length && other[j] === first[j]) j++;
    len = j;
  }
  return len;
}

/** The tokens every prompt in `prompts` starts with, and how many there are. */
export async function sharedPromptPrefix(
  prompts: string[],
): Promise<{ tokens: number[]; length: number }> {
  if (prompts.length < 2) return { tokens: [], length: 0 };
  const all = await Promise.all(prompts.map((p) => cachedTokenize(p)));
  const length = commonPrefixLength(all);
  return { tokens: all[0]!.slice(0, length), length };
}

/**
 * Whether to spend the extra call priming the shared prefix.
 *
 * Priming is not free: it makes every question extend a cached prefix, but it
 * also serialises the questions, giving up llama.cpp's continuous batching.
 * Measured break-even is ~140 tokens at Q=6 and ~420 at Q=20, so there is a
 * real crossover and `primeMinTokens` defaults to the conservative side of it.
 * `0` primes unconditionally; a negative value disables priming.
 */
export function shouldPrime(questionCount: number, sharedLength: number): boolean {
  if (config.primeMinTokens < 0) return false;
  return questionCount >= 2 && sharedLength >= config.primeMinTokens;
}

/**
 * Warm the KV cache (and the server's prompt cache) with the shared prefix.
 *
 * llama.cpp only restores a cached prompt when the cached tokens are a *prefix*
 * of the incoming prompt, so a fan-out of sibling questions — same state,
 * divergent tails — never reuses anything on its own. Issuing this one request
 * first makes every question prompt an extension of a cached prefix.
 *
 * `n_predict: 1` is required: the server has to evaluate (and generate) at
 * least one token for the state to be retained.
 */
export async function primePrefix(tokens: number[]): Promise<void> {
  if (tokens.length === 0) return;
  await completion({ prompt: tokens, n_predict: 1, n_probs: 1 });
}
