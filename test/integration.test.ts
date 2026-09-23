import { test, expect } from "bun:test";
import { evaluate } from "../src/evaluate.ts";

// Opt-in: requires a live pinned model at localhost:8080.
const maybe = process.env.S1_LIVE === "1" ? test : test.skip;

maybe(
  "noul / choice / score over the live model",
  async () => {
    const out = await evaluate({
      state: { review: "This product exceeded my expectations." },
      questions: [
        { id: "n", type: "noul", statement: "The review is positive." },
        {
          id: "c",
          type: "choice",
          prompt: "Overall sentiment",
          options: ["positive", "negative", "neutral"],
        },
        {
          id: "s",
          type: "score",
          prompt: "How urgent is this?",
          levels: ["none", "low", "medium", "high"],
        },
      ],
    });

    console.log(JSON.stringify(out, null, 2));
    expect(out.model).toBe("qwen38-flash-next");
    expect(out.answers).toHaveLength(3);
    for (const a of out.answers) expect(a.error).toBeUndefined();
    const sentiment = out.answers.find((a) => a.id === "c")!;
    expect(sentiment.value).toBe("positive");
  },
  180_000,
);

maybe(
  "single-pass returns every field in one call",
  async () => {
    const questions = [
      { id: "n", type: "noul" as const, statement: "The review is positive." },
      {
        id: "c",
        type: "choice" as const,
        prompt: "Overall sentiment",
        options: ["positive", "negative", "neutral"],
      },
      {
        id: "s",
        type: "score" as const,
        prompt: "How urgent is this?",
        levels: ["none", "low", "medium", "high"],
      },
    ];

    const out = await evaluate({
      state: { review: "This product exceeded my expectations." },
      questions,
      options: { mode: "single-pass" },
    });

    console.log(JSON.stringify(out, null, 2));
    expect(out.mode).toBe("single-pass");
    expect(out.timing.calls).toBe(1);
    expect(out.answers).toHaveLength(3);

    for (const a of out.answers) {
      expect(a.error).toBeUndefined();
      expect(a.strategy).toBe("single-pass");
      expect(questions.some((q) => q.id === a.id)).toBe(true);
    }

    const sentiment = out.answers.find((a) => a.id === "c")!;
    expect(["positive", "negative", "neutral"]).toContain(sentiment.value);
    expect(sentiment.value).toBe("positive");

    const noul = out.answers.find((a) => a.id === "n")!;
    expect(noul.probability).toBeGreaterThan(0.5);

    const score = out.answers.find((a) => a.id === "s")!;
    expect(score.score).toBeGreaterThan(0);
  },
  180_000,
);

maybe(
  "single-pass and per-question agree on the same state",
  async () => {
    const state = { review: "This product exceeded my expectations." };
    const questions = [
      {
        id: "sentiment",
        type: "choice" as const,
        prompt: "Overall sentiment",
        options: ["positive", "negative", "neutral"],
      },
    ];

    const [single, per] = await Promise.all([
      evaluate({ state, questions, options: { mode: "single-pass" } }),
      evaluate({ state, questions, options: { mode: "per-question" } }),
    ]);

    expect(single.answers[0]!.value).toBe(per.answers[0]!.value);
  },
  180_000,
);

maybe(
  "distinct first tokens need a single call",
  async () => {
    const out = await evaluate({
      state: { review: "This product exceeded my expectations." },
      questions: [
        {
          id: "sentiment",
          type: "choice",
          prompt: "Overall sentiment",
          options: ["positive", "negative", "neutral"],
        },
      ],
    });
    const a = out.answers[0]!;
    expect(a.strategy).toBe("raw");
    expect(a.calls).toBe(1);
    expect(a.value).toBe("positive");
  },
  120_000,
);

maybe(
  "colliding first tokens walk the trie",
  async () => {
    const out = await evaluate({
      state: { review: "This product exceeded my expectations." },
      questions: [
        {
          id: "tone",
          type: "choice",
          prompt: "Tone of the review",
          options: ["very positive", "very negative", "neutral"],
        },
      ],
    });
    const a = out.answers[0]!;
    expect(a.strategy).toBe("trie");
    expect(a.calls).toBeGreaterThan(1);
    const sum = Object.values(a.probabilities).reduce((x, y) => x + y, 0);
    expect(sum).toBeCloseTo(1, 6);
  },
  180_000,
);
