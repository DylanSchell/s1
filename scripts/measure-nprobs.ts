import { initCli } from "../src/config.ts";
import { applyTemplate, completion, detokenize } from "../src/llama.ts";
import {
  buildMessages,
  choiceUserContent,
  noulUserContent,
  scoreUserContent,
} from "../src/prompt.ts";
import { buildOptionPaths } from "../src/options.ts";
import { questionLabels, type Question } from "../src/primitives.ts";

initCli();

const triage = await Bun.file(
  new URL("../examples/triage-request.json", import.meta.url),
).json();
const state = triage.state;
const smokeState = {
  review: "This product exceeded my expectations. Shipping was slow though.",
  user: { name: "Dylan", plan: "pro" },
};

const smokeQuestions: Question[] = [
  { id: "smoke/positive", type: "noul", statement: "The review is positive overall." },
  { id: "smoke/shipping", type: "noul", statement: "The customer complains about shipping." },
  {
    id: "smoke/sentiment",
    type: "choice",
    prompt: "Overall sentiment",
    options: ["positive", "negative", "neutral"],
  },
  {
    id: "smoke/urgency",
    type: "score",
    prompt: "How urgently should support follow up?",
    levels: ["none", "low", "medium", "high"],
  },
];

// Shared-prefix case: forces a second-level trie node.
const tone: Question = {
  id: "tone",
  type: "choice",
  prompt: "Tone of the review",
  options: ["very positive", "very negative", "neutral"],
};

function userContentFor(q: Question): string {
  const labels = questionLabels(q);
  switch (q.type) {
    case "noul":
      return noulUserContent(q.statement);
    case "choice":
      return choiceUserContent(q.prompt, labels);
    case "score":
      return scoreUserContent(q.prompt, labels);
  }
}

const REQUEST_N = 4096;
const MATERIAL = 1e-3;

interface Hit {
  node: string;
  option: string;
  rank: number;
  prob: number;
}
const hits: Hit[] = [];

/**
 * Walk exactly the nodes scoreOptions walks: for every option token path and
 * every depth, append the shared prefix and read the rank of the next token.
 */
async function nodeRanks(label: string, st: unknown, q: Question): Promise<void> {
  const base = await applyTemplate(buildMessages(st, userContentFor(q)), {
    enable_thinking: false,
  });
  const paths = await buildOptionPaths(questionLabels(q), true);

  const nodes = new Map<string, { prefix: number[]; needed: Map<number, Set<string>> }>();
  for (const op of paths) {
    for (const p of op.paths) {
      for (let d = 0; d < p.length; d++) {
        const prefix = p.slice(0, d);
        const key = prefix.join(",");
        let node = nodes.get(key);
        if (!node) {
          node = { prefix, needed: new Map() };
          nodes.set(key, node);
        }
        let set = node.needed.get(p[d]!);
        if (!set) {
          set = new Set();
          node.needed.set(p[d]!, set);
        }
        set.add(op.option);
      }
    }
  }

  console.log(`\n${label}   (${nodes.size} node${nodes.size === 1 ? "" : "s"})`);
  for (const node of nodes.values()) {
    const prefixText = node.prefix.length ? await detokenize(node.prefix) : "";
    const res = await completion({ prompt: base + prefixText, n_predict: 1, n_probs: REQUEST_N });
    const top = [...(res.completion_probabilities?.[0]?.top_logprobs ?? [])].sort(
      (a, b) => b.logprob - a.logprob,
    );
    const rank = new Map<number, { rank: number; prob: number }>();
    top.forEach((p, i) => rank.set(p.id, { rank: i + 1, prob: Math.exp(p.logprob) }));

    const parts: string[] = [];
    for (const [tok, opts] of node.needed) {
      const r = rank.get(tok) ?? { rank: Infinity, prob: 0 };
      for (const o of opts) {
        hits.push({
          node: `${label}${prefixText ? ` +"${prefixText}"` : ""}`,
          option: o,
          rank: r.rank,
          prob: r.prob,
        });
      }
      const material = r.prob >= MATERIAL ? " *" : "  ";
      parts.push(
        `${[...opts].join("/")}=${r.rank === Infinity ? `>${REQUEST_N}` : r.rank}${material}`,
      );
    }
    console.log(
      `   depth=${node.prefix.length}${prefixText ? ` prefix="${prefixText}"` : ""}  ${parts.join("  ")}`,
    );
  }
}

console.log("=".repeat(78));
console.log("A. Rank of every token the trie reads (n_probs must reach the max)");
console.log("   * = token carries >= 1e-3 probability");
console.log("=".repeat(78));

for (const q of triage.questions as Question[]) await nodeRanks(q.id, state, q);
for (const q of smokeQuestions) await nodeRanks(q.id, smokeState, q);
await nodeRanks("tone", smokeState, tone);

const found = hits.filter((h) => Number.isFinite(h.rank));
const material = hits.filter((h) => h.prob >= MATERIAL);
const worstAll = Math.max(...found.map((h) => h.rank));
const worstMaterial = Math.max(...material.map((h) => h.rank));

console.log("\n" + "=".repeat(78));
console.log("B. Coverage by n_probs");
console.log("=".repeat(78));
console.log(`   total required-token reads : ${hits.length}`);
console.log(`   material reads (p>=1e-3)   : ${material.length}`);
console.log(`   worst rank, any token      : ${worstAll}`);
console.log(`   worst rank, material token : ${worstMaterial}`);
console.log("");
console.log("   N      all tokens   material tokens");
for (const n of [8, 16, 32, 64, 128, 256, 512]) {
  const a = hits.filter((h) => h.rank <= n).length;
  const m = material.filter((h) => h.rank <= n).length;
  console.log(
    `   ${String(n).padStart(4)}   ${String(a).padStart(3)}/${hits.length}` +
      `        ${String(m).padStart(3)}/${material.length}` +
      (m === material.length ? "   <- full material coverage" : ""),
  );
}

console.log("\n" + "=".repeat(78));
console.log("C. Cost of n_probs: latency and response payload (warm prompt, 3 runs)");
console.log("=".repeat(78));
{
  const q = triage.questions[0] as Question;
  const prompt = await applyTemplate(buildMessages(state, userContentFor(q)), {
    enable_thinking: false,
  });
  await completion({ prompt, n_predict: 1, n_probs: 8 });

  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  for (const n of [1, 16, 64, 128, 256, 512, 2048, 4096]) {
    const times: number[] = [];
    let bytes = 0;
    for (let i = 0; i < 3; i++) {
      const t = Bun.nanoseconds();
      const res = await completion({ prompt, n_predict: 1, n_probs: n });
      times.push((Bun.nanoseconds() - t) / 1e6);
      bytes = JSON.stringify(res.completion_probabilities ?? []).length;
    }
    console.log(
      `   n_probs=${String(n).padStart(5)}   median=${median(times).toFixed(1).padStart(7)} ms` +
        `   payload=${(bytes / 1024).toFixed(1).padStart(7)} KB`,
    );
  }
}
