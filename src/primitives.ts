import { config } from "./config.ts";
import { applyTemplate } from "./llama.ts";
import {
  buildMessages,
  choiceUserContent,
  noulUserContent,
  scoreUserContent,
  serializeInstructions,
} from "./prompt.ts";
import { scoreOptions, type Strategy } from "./scoring.ts";

/**
 * TypeSafe / llama.cpp `/v1/systemone` question. The request carries a MAP of
 * id → question, so `id` is the map key; `instructions` may be a string, object
 * or array; `criteria` shape depends on `type`:
 *   - choice: object of option → description|null
 *   - score:  array of 2–10 level descriptions, lowest first
 *   - noul:   optional object {false, true}
 */
/** Wire question: the map value, no id (id is the map key). */
export interface NoulSpec {
  type: "noul";
  instructions: unknown;
  criteria?: Record<string, unknown>;
}
export interface ChoiceSpec {
  type: "choice";
  instructions: unknown;
  criteria: Record<string, unknown>;
}
export interface ScoreSpec {
  type: "score";
  instructions: unknown;
  criteria: unknown[];
}
export type QuestionSpec = NoulSpec | ChoiceSpec | ScoreSpec;

/** Internal question: a wire spec plus its id. */
export type Question = QuestionSpec & { id: string };

/** The wire request shape: map of id -> question. */
export type QuestionsMap = Record<string, QuestionSpec>;

/**
 * The canonical answer options for a question, in schema order:
 *   - choice: the criteria keys
 *   - score:  the criteria array (level descriptions)
 *   - noul:   ["true", "false"] (criteria may carry descriptions, ignored here)
 */
export function questionLabels(q: Question): string[] {
  switch (q.type) {
    case "noul":
      return ["true", "false"];
    case "choice": {
      const keys = Object.keys(q.criteria ?? {});
      if (!keys.length) throw new Error(`question ${q.id}: criteria must be a non-empty object`);
      return keys;
    }
    case "score": {
      if (!q.criteria || q.criteria.length < 2) {
        throw new Error(`question ${q.id}: at least 2 levels required`);
      }
      return q.criteria.map((c) => (typeof c === "string" ? c : JSON.stringify(c)));
    }
  }
}

export interface Answer {
  id: string;
  type: Question["type"];
  /** Argmax label (`true`/`false` for noul). */
  value: string;
  /** Noul: P(true). */
  noul?: number;
  /** Choice: argmax option key. */
  choice?: string;
  /** Score: expected level index (0..n-1). */
  score?: number;
  /** Score: expected level normalized to 0..1 (s1 extension). */
  scoreNormalized?: number;
  /** Score: legend mapping index -> level description. */
  legend?: Record<string, string>;
  probabilities: Record<string, number>;
  /** TypeSafe confidence formula. */
  confidence: number;
  /** s1 extension: top probability (our former confidence). */
  topProbability: number;
  margin: number;
  strategy: Strategy;
  totalRaw: number;
  /**
   * False when the raw next-token distribution could not be read (e.g. a
   * speculatively-decoded token that llama.cpp does not report probs for).
   * When false, `probabilities` is empty, `confidence`/`topProbability` are 0,
   * and `value`/`score` come from the generated (constrained) output, not the
   * missing distribution. Defaults to true when omitted.
   */
  probabilitiesAvailable?: boolean;
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

function topStats(probs: Record<string, number>): { value: string; top: number; second: number } {
  const entries = Object.entries(probs).sort((a, b) => b[1] - a[1]);
  const value = entries[0]?.[0] ?? "";
  const top = entries[0]?.[1] ?? 0;
  const second = entries[1]?.[1] ?? 0;
  return { value, top, second };
}

/** TypeSafe confidence for a choice: (p_max - uniform)/(1 - uniform). */
export function confidenceChoice(probs: Record<string, number>): number {
  const n = Object.keys(probs).length;
  if (n < 2) return 1;
  const { top } = topStats(probs);
  const uniform = 1 / n;
  return Math.max(0, (top - uniform) / (1 - uniform));
}

/** TypeSafe confidence for a score: 1 - (mean distance to mode)/(uniform distance). */
export function confidenceScore(probs: number[]): number {
  const n = probs.length;
  if (n < 2) return 1;
  const mode = probs.indexOf(Math.max(...probs));
  let dist = 0;
  let distUniform = 0;
  for (let i = 0; i < n; i++) {
    dist += probs[i]! * Math.abs(i - mode);
    distUniform += Math.abs(i - (n - 1) / 2) / n;
  }
  return Math.max(0, 1 - dist / distUniform);
}

/** The user turn for a question (the per-question prompt body). */
export function questionUserContent(q: Question): string {
  const labels = questionLabels(q);
  switch (q.type) {
    case "noul":
      return noulUserContent(q.instructions);
    case "choice":
      return choiceUserContent(q.instructions, labels);
    case "score":
      return scoreUserContent(q.instructions, labels);
  }
}

export interface PreparedQuestion {
  question: Question;
  labels: string[];
  /** The user turn. */
  content: string;
  /** The fully templated prompt sent to /completion. */
  prompt: string;
}

/**
 * Build one question's prompt without spending a forward pass. Split out from
 * scoring so the orchestrator can inspect every prompt (and prime their shared
 * prefix) before any of them are scored.
 */
export async function prepareQuestion(state: unknown, q: Question): Promise<PreparedQuestion> {
  const labels = questionLabels(q);
  const content = questionUserContent(q);
  const prompt = await applyTemplate(buildMessages(state, content), {
    enable_thinking: false,
  });
  return { question: q, labels, content, prompt };
}

/** Score an already-prepared question. Spends `scoreOptions`' completion calls. */
export async function scorePrepared(
  prep: PreparedQuestion,
  opts: AnswerOptions = {},
): Promise<Answer> {
  const started = performance.now();
  const { question: q, labels, prompt } = prep;

  const scored = await scoreOptions(prompt, labels, {
    nProbs: opts.nProbs ?? config.nProbs,
    includeCaseVariants: opts.includeCaseVariants ?? true,
  });

  const probabilities = temperatureScale(scored.probabilities, opts.temperature ?? 1);
  const { value, top, second } = topStats(probabilities);

  return decorateAnswer(q, {
    id: q.id,
    type: q.type,
    value,
    probabilities,
    confidence: 0, // set by decorateAnswer
    topProbability: top,
    margin: top - second,
    strategy: scored.strategy,
    totalRaw: scored.totalRaw,
    calls: scored.calls,
    latencyMs: Math.round(performance.now() - started),
  });
}

/**
 * Apply the TypeSafe answer derivations (noul / choice / score) and the s1
 * extras (topProbability, scoreNormalized) to a scored answer. `probabilities`
 * is the label-keyed map; for score it is re-keyed to index strings with a
 * `legend`.
 */
export function decorateAnswer(q: Question, answer: Answer): Answer {
  const labels = questionLabels(q);

  // When the raw distribution is unavailable (probabilitiesAvailable === false),
  // `value` is the generated (constrained) answer and must be preserved. Only
  // the probability-derived fields (confidence, topProbability, noul, score)
  // are left at their sentinel/absent values.
  if (answer.probabilitiesAvailable === false) {
    if (q.type === "choice") {
      answer.choice = answer.value;
    } else if (q.type === "score") {
      const idx = Math.max(0, labels.indexOf(answer.value));
      answer.legend = Object.fromEntries(labels.map((lvl, i) => [String(i), lvl]));
      const k = labels.length;
      answer.score = idx;
      answer.scoreNormalized = k > 1 ? idx / (k - 1) : 0;
      answer.value = labels[idx] ?? "";
    }
    answer.topProbability = 0;
    answer.margin = 0;
    answer.confidence = 0;
    return answer;
  }

  if (q.type === "noul") {
    const p = answer.probabilities["true"] ?? 0;
    answer.noul = p;
    answer.value = p >= 0.5 ? "true" : "false";
    answer.confidence = Math.abs(p - 0.5) * 2;
    answer.margin = Math.abs(p - (1 - p));
  } else if (q.type === "choice") {
    answer.choice = answer.value;
    answer.confidence = confidenceChoice(answer.probabilities);
  } else {
    // score: re-key to index strings and attach a legend; keep normalized too.
    const indexProbs: Record<string, number> = {};
    const legend: Record<string, string> = {};
    let expected = 0;
    labels.forEach((lvl, i) => {
      const p = answer.probabilities[lvl] ?? 0;
      indexProbs[String(i)] = p;
      legend[String(i)] = lvl;
      expected += i * p;
    });
    answer.probabilities = indexProbs;
    answer.legend = legend;
    answer.score = expected;
    const k = labels.length;
    answer.scoreNormalized = k > 1 ? expected / (k - 1) : 0;
    answer.value = labels[Math.round(expected)] ?? labels[0] ?? "";
    const vals = labels.map((_, i) => indexProbs[String(i)]!);
    const { top, second } = topStats(indexProbs);
    answer.topProbability = top;
    answer.margin = top - second;
    answer.confidence = confidenceScore(vals);
  }
  return answer;
}

/** Prepare and score a single question. No priming — see `evaluate`. */
export async function answerQuestion(
  state: unknown,
  q: Question,
  opts: AnswerOptions = {},
): Promise<Answer> {
  return scorePrepared(await prepareQuestion(state, q), opts);
}
