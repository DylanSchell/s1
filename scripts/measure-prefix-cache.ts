import { initCli } from "../src/config.ts";
import { completion, tokenize } from "../src/llama.ts";

initCli();

/**
 * Demonstrates the prompt-cache reuse law on this llama-swap instance.
 *
 * All prompts carry a fresh UUID so nothing can be pre-cached by an earlier
 * run. Every call is pinned to one slot and issued sequentially, so the only
 * variable is how the new prompt relates to the cached one.
 */
const n = crypto.randomUUID();
const BASE = [
  "You are a precise classifier. Read the STATE and answer the QUESTION.",
  "STATE:",
  "A customer reports that a password reset succeeded, but every login attempt",
  "still returns account locked. Two unlock emails were requested and neither",
  "has arrived. The customer has been a paid subscriber for seven years and is",
  "now unable to reach their billing dashboard, their saved reports, or their",
  "team workspace. Support has not responded for three days.",
  `MARKER ${n}`,
].join("\n");

const A = `${BASE}\nQuestion: which queue? token=${n}\nAnswer:`;
const EXT = `${A}\nExtra line: please be brief.`; // A is a strict prefix of EXT
const DIV = `${BASE}\nQuestion: which system is at fault? token=${n}\nAnswer:`; // diverges after BASE
const EVICT = `Filler ${n} ` + "padding ".repeat(300);

const toks = await Promise.all([A, EXT, DIV, EVICT].map((p) => tokenize(p)));
const [tA, tExt, tDiv, tEvict] = toks as [number[], number[], number[], number[]];
const lcp = (x: number[], y: number[]) => {
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i;
};

console.log(`len(A)=${tA.length}  len(EXT)=${tExt.length}  len(DIV)=${tDiv.length}`);
console.log(`lcp(A,EXT)=${lcp(tA, tExt)}  (A is a strict prefix of EXT)`);
console.log(`lcp(A,DIV)=${lcp(tA, tDiv)}  (DIV diverges after the shared BASE)\n`);

interface Timings {
  cache_n?: number;
  prompt_n?: number;
}
async function call(label: string, prompt: string, expect: string) {
  const res = (await completion({
    prompt,
    n_predict: 1,
    n_probs: 1,
    id_slot: 0,
  })) as { timings?: Timings };
  const t = res.timings ?? {};
  const ok = (t.cache_n ?? 0) > 0 ? "reused" : "MISS  ";
  console.log(
    `  ${label.padEnd(30)} cache_n=${String(t.cache_n ?? "-").padStart(4)}` +
      `  prompt_n=${String(t.prompt_n ?? "-").padStart(4)}  ${ok}   ${expect}`,
  );
}

await call("evict (unrelated)", EVICT, "cold");
await call("A (first sight)", A, "cache_n=0 expected");
await call("A (identical repeat)", A, "full reuse");
await call("EXT (A is a prefix of EXT)", EXT, "full reuse");
await call("DIV (sibling, diverges)", DIV, "cache_n=0 expected");
await call("A again (now shorter than DIV)", A, "cache_n=0 expected");

console.log(
  "\n  Law: llama.cpp restores a cached state only when the cached prompt is a\n" +
    "  PREFIX of the incoming prompt. Sibling prompts that share a head and then\n" +
    "  diverge reuse nothing — which is why s1 primes the shared prefix first.",
);
void tEvict;
