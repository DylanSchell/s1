import { test, expect } from "bun:test";
import { evaluate } from "../src/evaluate.ts";
import type { QuestionsMap } from "../src/primitives.ts";

// Opt-in: requires a live pinned model at localhost:8080.
const maybe = process.env.S1_LIVE === "1" ? test : test.skip;

const state = { review: "This product exceeded my expectations." };

const questions: QuestionsMap = {
  n: { type: "noul", instructions: "The review is positive." },
  c: { type: "choice", instructions: "Overall sentiment", criteria: { positive: null, negative: null, neutral: null } },
  s: { type: "score", instructions: "How urgent is this?", criteria: ["none", "low", "medium", "high"] },
};

maybe(
  "noul / choice / score over the live model",
  async () => {
    const out = await evaluate({ state, questions });
    console.log(JSON.stringify(out, null, 2));
    expect(out.model).toBe("deepseek-v4-flash-0731");
    expect(Object.keys(out.answers)).toHaveLength(3);
    for (const a of Object.values(out.answers)) expect(a.error).toBeUndefined();
    const sentiment = out.answers["c"]!;
    expect(sentiment.choice).toBe("positive");
  },
  180_000,
);

maybe(
  "single-pass returns every field in one call",
  async () => {
    const out = await evaluate({ state, questions, options: { mode: "single-pass" } });
    console.log(JSON.stringify(out, null, 2));
    expect(out.mode).toBe("single-pass");
    expect(out.timing.calls).toBe(1);
    expect(Object.keys(out.answers)).toHaveLength(3);

    for (const a of Object.values(out.answers)) {
      expect(a.error).toBeUndefined();
      expect(a.strategy).toBe("single-pass");
    }

    const sentiment = out.answers["c"]!;
    expect(["positive", "negative", "neutral"]).toContain(sentiment.choice!);
    expect(sentiment.choice).toBe("positive");

    const noul = out.answers["n"]!;
    expect(noul.noul!).toBeGreaterThan(0.5);

    const score = out.answers["s"]!;
    expect(score.score!).toBeGreaterThan(0);
  },
  180_000,
);

maybe(
  "single-pass and per-question agree on the same state",
  async () => {
    const [single, per] = await Promise.all([
      evaluate({ state, questions, options: { mode: "single-pass" } }),
      evaluate({ state, questions, options: { mode: "per-question" } }),
    ]);

    expect(single.answers["c"]!.choice).toBe(per.answers["c"]!.choice);
  },
  180_000,
);

maybe(
  "distinct first tokens need a single call",
  async () => {
    const out = await evaluate({
      state,
      questions: { sentiment: questions.c },
    });
    const a = out.answers["sentiment"]!;
    expect(a.strategy).toBe("raw");
    expect(a.calls).toBe(1);
    expect(a.choice).toBe("positive");
  },
  120_000,
);

maybe(
  "colliding first tokens walk the trie",
  async () => {
    const out = await evaluate({
      state,
      questions: { tone: { type: "choice", instructions: "Tone of the review", criteria: { "very positive": null, "very negative": null, neutral: null } } },
    });
    const a = out.answers["tone"]!;
    expect(a.strategy).toBe("trie");
    expect(a.calls).toBeGreaterThan(1);
    const sum = Object.values(a.probabilities).reduce((x, y) => x + y, 0);
    expect(sum).toBeCloseTo(1, 6);
  },
  180_000,
);
