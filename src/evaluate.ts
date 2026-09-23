import { config } from "./config.ts";
import {
  answerQuestion,
  type Answer,
  type AnswerOptions,
  type EvaluateMode,
  type Question,
} from "./primitives.ts";
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
  timing: { totalMs: number; calls: number };
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

  const answers = await Promise.all(
    req.questions.map(async (q): Promise<Answer> => {
      try {
        return await answerQuestion(req.state, q, req.options);
      } catch (e) {
        return errorAnswer(q, e instanceof Error ? e.message : String(e));
      }
    }),
  );

  return {
    answers,
    model: config.model,
    mode,
    timing: {
      totalMs: Math.round(performance.now() - started),
      calls: answers.reduce((a, b) => a + b.calls, 0),
    },
  };
}
