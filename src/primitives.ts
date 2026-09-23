import { config } from "./config.ts";
import { applyTemplate } from "./llama.ts";
import {
  buildMessages,
  choiceUserContent,
  noulUserContent,
  scoreUserContent,
} from "./prompt.ts";
import { scoreOptions, type Strategy } from "./scoring.ts";

export interface NoulQuestion {
  id: string;
  type: "noul";
  statement: string;
}
export interface ChoiceQuestion {
  id: string;
  type: "choice";
  prompt: string;
  options: string[];
}
export interface ScoreQuestion {
  id: string;
  type: "score";
  prompt: string;
  levels: string[];
}
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface Answer {
  id: string;
  type: Question["type"];
  /** Argmax label (`yes`/`no` for noul). */
  value: string;
  /** Noul: P(yes). */
  probability?: number;
  /** Score: expected level normalized to 0..1. */
  score?: number;
  /** Score: expected level index. */
  level?: number;
  probabilities: Record<string, number>;
  confidence: number;
  margin: number;
  strategy: Strategy;
  totalRaw: number;
  /** /completion calls attributable to this answer (0 in single-pass mode). */
  calls: number;
  latencyMs: number;
  error?: string;
}

export type EvaluateMode = "per-question" | "single-pass";

export interface AnswerOptions {
  /** Temperature scaling applied to the probability map (calibration hook). */
  temperature?: number;
  /** n_probs / top-N requested for each distribution read. */
  nProbs?: number;
  includeCaseVariants?: boolean;
  /** per-question = one score per question; single-pass = one shared call. */
  mode?: EvaluateMode;
}

/** Temperature scaling = softmax(logits / T). T > 1 softens, T < 1 sharpens. */
export function temperatureScale(probs: Record<string, number>, t: number): Record<string, number> {
  if (!Number.isFinite(t) || t <= 0 || t === 1) return probs;
  const scaled: Record<string, number> = {};
  let sum = 0;
  for (const [k, v] of Object.entries(probs)) {
    const x = Math.pow(Math.max(v, 0), 1 / t);
    scaled[k] = x;
    sum += x;
  }
  if (sum <= 0) return probs;
  for (const k of Object.keys(scaled)) scaled[k]! /= sum;
  return scaled;
}

function topStats(probs: Record<string, number>): {
  value: string;
  confidence: number;
  margin: number;
} {
  const entries = Object.entries(probs).sort((a, b) => b[1] - a[1]);
  const value = entries[0]?.[0] ?? "";
  const top = entries[0]?.[1] ?? 0;
  const second = entries[1]?.[1] ?? 0;
  return { value, confidence: top, margin: top - second };
}

/** The canonical labels a question is answered with, in schema order. */
export function questionLabels(q: Question): string[] {
  switch (q.type) {
    case "noul":
      return ["yes", "no"];
    case "choice": {
      if (!q.options?.length) throw new Error(`question ${q.id}: options required`);
      return [...new Set(q.options)];
    }
    case "score": {
      if (!q.levels || q.levels.length < 2) {
        throw new Error(`question ${q.id}: at least 2 levels required`);
      }
      return [...new Set(q.levels)];
    }
  }
}

function userContentFor(q: Question): { labels: string[]; content: string } {
  const labels = questionLabels(q);
  switch (q.type) {
    case "noul":
      return { labels, content: noulUserContent(q.statement) };
    case "choice":
      return { labels, content: choiceUserContent(q.prompt, labels) };
    case "score":
      return { labels, content: scoreUserContent(q.prompt, labels) };
  }
}

/** Apply the type-specific derivations (noul / score) to a scored answer. */
export function decorateAnswer(q: Question, answer: Answer): Answer {
  if (q.type === "noul") {
    const p = answer.probabilities["yes"] ?? 0;
    answer.probability = p;
    answer.confidence = Math.abs(p - 0.5) * 2;
    answer.margin = Math.abs(p - (1 - p));
  } else if (q.type === "score") {
    const labels = questionLabels(q);
    const k = labels.length;
    let expected = 0;
    labels.forEach((lvl, i) => {
      expected += i * (answer.probabilities[lvl] ?? 0);
    });
    answer.level = expected;
    answer.score = k > 1 ? expected / (k - 1) : 0;
  }
  return answer;
}

export async function answerQuestion(
  state: unknown,
  q: Question,
  opts: AnswerOptions = {},
): Promise<Answer> {
  const started = performance.now();
  const { labels, content } = userContentFor(q);
  const prompt = await applyTemplate(buildMessages(state, content), {
    enable_thinking: false,
  });

  const scored = await scoreOptions(prompt, labels, {
    nProbs: opts.nProbs ?? config.nProbs,
    includeCaseVariants: opts.includeCaseVariants ?? true,
  });

  const probabilities = temperatureScale(scored.probabilities, opts.temperature ?? 1);
  const { value, confidence, margin } = topStats(probabilities);

  return decorateAnswer(q, {
    id: q.id,
    type: q.type,
    value,
    probabilities,
    confidence,
    margin,
    strategy: scored.strategy,
    totalRaw: scored.totalRaw,
    calls: scored.calls,
    latencyMs: Math.round(performance.now() - started),
  });
}
