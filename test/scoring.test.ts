import { test, expect } from "bun:test";
import { surfaceForms } from "../src/options.ts";
import {
  confidenceChoice,
  confidenceScore,
  decorateAnswer,
  temperatureScale,
  type Answer,
} from "../src/primitives.ts";

test("surfaceForms covers spacing and case", () => {
  expect(new Set(surfaceForms("yes"))).toEqual(new Set(["yes", " yes", "Yes", " Yes"]));
});

test("surfaceForms handles a leading-space option", () => {
  expect(new Set(surfaceForms(" positive"))).toEqual(
    new Set([" positive", "positive", " Positive", "Positive"]),
  );
});

test("surfaceForms can skip case variants", () => {
  expect(new Set(surfaceForms("yes", false))).toEqual(new Set(["yes", " yes"]));
});

test("temperatureScale sharpens and preserves order", () => {
  const sharp = temperatureScale({ a: 0.9, b: 0.1 }, 0.5);
  expect(sharp.a!).toBeGreaterThan(0.9);
  expect(sharp.a! + sharp.b!).toBeCloseTo(1, 10);
});

test("temperatureScale is identity at T=1", () => {
  const p = { a: 0.3, b: 0.7 };
  expect(temperatureScale(p, 1)).toEqual(p);
});

test("confidenceChoice is 0 at uniform and 1 at a lone option", () => {
  expect(confidenceChoice({ a: 1 / 3, b: 1 / 3, c: 1 / 3 })).toBeCloseTo(0, 10);
  expect(confidenceChoice({ a: 1 })).toBeCloseTo(1, 10);
  const mid = confidenceChoice({ a: 0.8, b: 0.2 });
  expect(mid).toBeCloseTo((0.8 - 0.5) / (1 - 0.5), 10);
});

test("confidenceScore is 0 at uniform and 1 at a point mass", () => {
  expect(confidenceScore([0.25, 0.25, 0.25, 0.25])).toBeCloseTo(0, 10);
  expect(confidenceScore([1, 0, 0])).toBeCloseTo(1, 10);
});

function base(partial: Partial<Answer>): Answer {
  return {
    id: "x",
    type: "choice",
    value: "",
    probabilities: {},
    confidence: 0,
    topProbability: 0,
    margin: 0,
    strategy: "raw",
    totalRaw: 0,
    calls: 0,
    latencyMs: 0,
    ...partial,
  };
}

test("decorateAnswer preserves the value when probabilities are unavailable", () => {
  const score = decorateAnswer(
    { id: "u", type: "score", instructions: "How urgent?", criteria: ["low", "medium", "high"] },
    base({ type: "score", value: "high", probabilitiesAvailable: false }),
  );
  expect(score.value).toBe("high");
  expect(score.score).toBe(2);
  expect(score.scoreNormalized).toBeCloseTo(1, 10);
  expect(score.legend).toEqual({ "0": "low", "1": "medium", "2": "high" });
  expect(score.confidence).toBe(0);
  expect(score.probabilities).toEqual({});

  const choice = decorateAnswer(
    { id: "c", type: "choice", instructions: "Pick", criteria: { a: null, b: null } },
    base({ value: "a", probabilitiesAvailable: false }),
  );
  expect(choice.choice).toBe("a");
  expect(choice.confidence).toBe(0);

  const noul = decorateAnswer(
    { id: "n", type: "noul", instructions: "Is it true?" },
    base({ type: "noul", value: "true", probabilitiesAvailable: false }),
  );
  expect(noul.value).toBe("true");
  expect(noul.noul).toBeUndefined();
  expect(noul.confidence).toBe(0);
});

test("decorateAnswer re-keys a score to index strings with a legend", () => {
  const score = decorateAnswer(
    { id: "u", type: "score", instructions: "How urgent?", criteria: ["low", "medium", "high"] },
    base({ type: "score", value: "medium", probabilities: { low: 0.1, medium: 0.8, high: 0.1 } }),
  );
  expect(score.probabilities).toEqual({ "0": 0.1, "1": 0.8, "2": 0.1 });
  expect(score.legend).toEqual({ "0": "low", "1": "medium", "2": "high" });
  expect(score.score).toBeCloseTo(1, 10);
  expect(score.scoreNormalized).toBeCloseTo(0.5, 10);
  expect(score.value).toBe("medium");
  expect(score.confidence).toBeGreaterThan(0);
});
