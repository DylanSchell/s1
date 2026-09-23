import { config } from "./config.ts";
import { applyTemplate, completion, type CompletionProb } from "./llama.ts";
import { alternationOfPaths } from "./grammar.ts";
import {
  buildOptionPaths,
  cachedTokenize,
  flattenPaths,
  hasCrossOptionPrefix,
  matchOptionPath,
  type OptionPath,
} from "./options.ts";
import { buildMessages } from "./prompt.ts";
import {
  decorateAnswer,
  questionLabels,
  type Answer,
  type AnswerOptions,
  type Question,
} from "./primitives.ts";

interface Field {
  question: Question;
  labels: string[];
  optionPaths: OptionPath[];
}

function listContent(questions: Question[]): string {
  const lines = questions.map((q, i) => {
    const n = i + 1;
    switch (q.type) {
      case "noul":
        return `${n}. ${q.statement} [yes | no]`;
      case "choice":
        return `${n}. ${q.prompt} [${questionLabels(q).join(" | ")}]`;
      // Preserve the ordering signal that the per-question prompt encodes with
      // `<`; a `|` list reads as unordered and lets the model hedge to the middle.
      case "score":
        return `${n}. ${q.prompt} [ordered scale: ${questionLabels(q).join(" < ")}]`;
    }
  });
  return [
    "Answer every question using exactly one of its options.",
    "Write one answer per line, in the same order as the questions.",
    "",
    ...lines,
  ].join("\n");
}

/**
 * A token-level grammar over the whole document: each field is an alternation of
 * its options' token paths, fields are separated by the newline token. Because
 * every token is pinned by id, the generated sequence is fully determined by the
 * per-field choices — so a field's value can be located exactly in the stream.
 */
function grammarFor(fields: Field[], nlId: number): string {
  const rules = fields.map(
    (f, i) => `f${i} ::= ${alternationOfPaths(f.optionPaths.flatMap((op) => op.paths))}`,
  );
  const root = fields.map((_, i) => `f${i}`).join(` <[${nlId}]> `);
  return [`root ::= ${root}`, ...rules].join("\n");
}

interface Dist {
  probabilities: Record<string, number>;
  rawTotal: number;
}

/**
 * Best-effort per-field distribution from the raw (grammar-ignorant) next-token
 * read at the field's first generated token. Exact when each option starts with
 * a distinct token; for shared-prefix options the mass of the shared prefix is
 * attributed across its options.
 */
function firstTokenDistribution(
  probs: CompletionProb[],
  start: number,
  field: Field,
): Dist {
  const dist = new Map<number, number>();
  for (const p of probs[start]?.top_logprobs ?? []) dist.set(p.id, Math.exp(p.logprob));

  const raw: Record<string, number> = {};
  for (const op of field.optionPaths) {
    let mass = 0;
    for (const path of op.paths) mass += dist.get(path[0]!) ?? 0;
    raw[op.option] = mass;
  }
  let total = 0;
  for (const v of Object.values(raw)) total += v;

  const probabilities: Record<string, number> = {};
  for (const op of field.optionPaths) {
    probabilities[op.option] =
      total > 0 ? raw[op.option]! / total : 1 / field.optionPaths.length;
  }
  return { probabilities, rawTotal: total };
}

/**
 * Answer every question in a single grammar-constrained generation: one
 * `/completion` call whose output can only be one option per field. The value is
 * therefore always in-schema; per-field probabilities are recovered from the raw
 * next-token read at each field's position.
 */
export async function answerAll(
  state: unknown,
  questions: Question[],
  opts: AnswerOptions = {},
): Promise<Answer[]> {
  if (questions.length === 0) return [];
  const started = performance.now();

  const fields: Field[] = [];
  for (const q of questions) {
    const labels = questionLabels(q);
    const optionPaths = await buildOptionPaths(labels, opts.includeCaseVariants ?? true);
    if (hasCrossOptionPrefix(flattenPaths(optionPaths))) {
      throw new Error(`question ${q.id}: options overlap at a token boundary`);
    }
    fields.push({ question: q, labels, optionPaths });
  }

  const nlIds = await cachedTokenize("\n");
  if (nlIds.length !== 1) {
    throw new Error(
      `single-pass requires "\\n" to tokenize to exactly one token (got ${nlIds.length})`,
    );
  }
  const nlId = nlIds[0]!;

  const prompt = await applyTemplate(buildMessages(state, listContent(questions)), {
    enable_thinking: false,
  });
  const grammar = grammarFor(fields, nlId);

  const maxFieldTokens = fields.map((f) =>
    Math.max(...f.optionPaths.flatMap((op) => op.paths.map((p) => p.length))),
  );
  const maxTokens = maxFieldTokens.reduce((a, b) => a + b, 0) + (fields.length - 1);

  const res = await completion({
    prompt,
    grammar,
    temperature: 0,
    n_predict: maxTokens + 1,
    n_probs: opts.nProbs ?? config.nProbs,
    post_sampling_probs: false,
  });

  const probs = res.completion_probabilities ?? [];
  const tokens = probs.map((p) => p.id);

  // Split the generated stream into per-field segments on the newline token.
  const segments: { tokens: number[]; start: number }[] = [];
  let current: number[] = [];
  let currentStart = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === nlId) {
      segments.push({ tokens: current, start: currentStart });
      current = [];
      currentStart = i + 1;
    } else {
      current.push(tokens[i]!);
    }
  }
  if (current.length > 0) segments.push({ tokens: current, start: currentStart });

  const answers: Answer[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    const seg = segments[i];

    let chosen = seg ? matchOptionPath(f.optionPaths, seg.tokens) : -1;
    // The final field may be followed by the EOS token; retry without it.
    if (chosen < 0 && seg && seg.tokens.length > 0) {
      chosen = matchOptionPath(f.optionPaths, seg.tokens.slice(0, -1));
    }

    const dist = seg
      ? firstTokenDistribution(probs, seg.start, f)
      : { probabilities: {}, rawTotal: 0 };
    const sorted = Object.entries(dist.probabilities).sort((a, b) => b[1] - a[1]);

    const answer: Answer = {
      id: f.question.id,
      type: f.question.type,
      value: chosen >= 0 ? f.labels[chosen]! : "",
      probabilities: dist.probabilities,
      confidence: sorted[0]?.[1] ?? 0,
      margin: (sorted[0]?.[1] ?? 0) - (sorted[1]?.[1] ?? 0),
      strategy: "single-pass",
      totalRaw: dist.rawTotal,
      calls: 0,
      latencyMs: Math.round(performance.now() - started),
    };
    if (chosen < 0) answer.error = "generated tokens did not match an option";
    answers.push(decorateAnswer(f.question, answer));
  }
  return answers;
}
