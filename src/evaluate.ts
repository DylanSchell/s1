import { config } from "./config.ts";
import {
  prepareQuestion,
  scorePrepared,
  type Answer,
  type AnswerOptions,
  type EvaluateMode,
  type PreparedQuestion,
  type Question,
} from "./primitives.ts";
import { primePrefix, sharedPromptPrefix, shouldPrime } from "./prefix.ts";
import { answerAll } from "./singlePass.ts";

export interface EvaluateRequest {
  state: unknown;
  questions: Question[];
  options?: AnswerOptions;
}

export interface EvaluateResult {
  answers: Answer[];
  model: string;
  mode: EvaluateMode;
  timing: {
    totalMs: number;
    calls: number;
    /** Shared-prefix tokens primed for reuse, when priming was worthwhile. */
    primeTokens?: number;
  };
}

function errorAnswer(q: Question, message: string): Answer {
  return {
    id: q.id,
    type: q.type,
    value: "",
    probabilities: {},
    confidence: 0,
    margin: 0,
    strategy: "raw",
    totalRaw: 0,
    calls: 0,
    latencyMs: 0,
    error: message,
  };
}

interface Slot {
  question: Question;
  prep?: PreparedQuestion;
  error?: string;
}

export async function evaluate(req: EvaluateRequest): Promise<EvaluateResult> {
  if (!req || typeof req !== "object") throw new Error("body must be an object");
  if (!Array.isArray(req.questions)) throw new Error("questions must be an array");

  const started = performance.now();
  const mode: EvaluateMode = req.options?.mode ?? "per-question";

  if (mode === "single-pass") {
    let answers: Answer[];
    try {
      answers = await answerAll(req.state, req.questions, req.options);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      answers = req.questions.map((q) => errorAnswer(q, message));
    }
    return {
      answers,
      model: config.model,
      mode,
      timing: {
        totalMs: Math.round(performance.now() - started),
        calls: req.questions.length > 0 ? 1 : 0,
      },
    };
  }

  // Build every prompt first (no forward passes), so the shared prefix can be
  // primed before any of them is scored.
  const slots: Slot[] = await Promise.all(
    req.questions.map(async (q): Promise<Slot> => {
      try {
        return { question: q, prep: await prepareQuestion(req.state, q) };
      } catch (e) {
        return { question: q, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );

  const prepared = slots
    .map((s) => s.prep)
    .filter((p): p is PreparedQuestion => p !== undefined);

  let primeTokens = 0;
  if (prepared.length >= 2) {
    try {
      const { tokens, length } = await sharedPromptPrefix(prepared.map((p) => p.prompt));
      if (shouldPrime(prepared.length, length)) {
        await primePrefix(tokens);
        primeTokens = length;
      }
    } catch {
      // Priming is an optimisation: never fail a request because of it.
    }
  }

  const scoreOne = async (s: Slot): Promise<Answer> => {
    if (!s.prep) return errorAnswer(s.question, s.error ?? "could not prepare question");
    try {
      return await scorePrepared(s.prep, req.options);
    } catch (e) {
      return errorAnswer(s.question, e instanceof Error ? e.message : String(e));
    }
  };

  // A primed prefix is only reused if the question lands on an idle slot, so
  // once priming has happened the questions are asked one at a time. Measured
  // on a ~1.4k-token state: serial + primed reuses the prefix for all six
  // questions, concurrent + primed for only three.
  let answers: Answer[];
  if (primeTokens > 0) {
    answers = [];
    for (const s of slots) answers.push(await scoreOne(s));
  } else {
    answers = await Promise.all(slots.map(scoreOne));
  }

  const timing: EvaluateResult["timing"] = {
    totalMs: Math.round(performance.now() - started),
    calls: answers.reduce((a, b) => a + b.calls, 0) + (primeTokens > 0 ? 1 : 0),
  };
  if (primeTokens > 0) timing.primeTokens = primeTokens;

  return { answers, model: config.model, mode, timing };
}
