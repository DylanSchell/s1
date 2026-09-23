import { config, initCli } from "../src/config.ts";
import { evaluate } from "../src/evaluate.ts";

initCli();

/**
 * Finds where priming starts to pay for itself.
 *
 * Priming is a trade: it makes every question an extension of a cached prefix,
 * but it also serialises the questions, giving up llama.cpp's continuous
 * batching. This sweeps shared-prefix length against question count.
 *
 * Methodology, because it is easy to get wrong:
 *
 *   - Every measurement uses a **unique state** (fresh UUID). All measurements
 *     share one llama.cpp prompt cache, so reusing a state lets whichever run
 *     goes second inherit the first one's warm prefix and produce nonsense.
 *     (An earlier version of this benchmark reused one state for both runs and
 *     reported priming as a free 1.01x win on the short state.)
 *   - The priming toggle is `0` (always) vs `-1` (never), and the order
 *     alternates per rep so neither side systematically goes first.
 *   - Five reps, median.
 */

const EXAMPLE = (await Bun.file(
  new URL("../examples/triage-request.json", import.meta.url),
).json()) as { state: string; questions: unknown[] };

const BASE_QUESTIONS = EXAMPLE.questions;
const BASE_STATE = EXAMPLE.state;

const mkState = (k: number) => (uuid: string) => `${BASE_STATE}\n${"detail ".repeat(k)}ref ${uuid}`;

/**
 * Loaded from the real example rather than hand-written, because a hand-written
 * copy silently drifted: `score` questions take `levels`, not `options`, so two
 * of the six were failing validation and the sweep was really measuring Q=4.
 */
const mkQuestions = (q: number) =>
  Array.from({ length: q }, (_, i) => ({
    ...(BASE_QUESTIONS[i % BASE_QUESTIONS.length] as object),
    id: `q${i}`,
  }));

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

interface Run {
  ms: number;
  primeTokens: number;
  errors: string[];
}

async function run(priming: number, state: string, questions: unknown[]): Promise<Run> {
  config.primeMinTokens = priming;
  const t0 = performance.now();
  const out = await evaluate({ state, questions } as never);
  const ms = Math.round(performance.now() - t0);
  const errors = out.answers.filter((a) => a.error).map((a) => a.error!);
  return { ms, primeTokens: out.timing.primeTokens ?? 0, errors };
}

async function compare(k: number, q: number, reps = 5): Promise<void> {
  const on: number[] = [];
  const off: number[] = [];
  let prefix = 0;
  const errors: string[] = [];

  for (let r = 0; r < reps; r++) {
    const onFirst = r % 2 === 0;
    const a = await run(onFirst ? 0 : -1, mkState(k)(crypto.randomUUID()), mkQuestions(q));
    const b = await run(onFirst ? -1 : 0, mkState(k)(crypto.randomUUID()), mkQuestions(q));
    (onFirst ? on : off).push(a.ms);
    (onFirst ? off : on).push(b.ms);
    prefix = onFirst ? a.primeTokens : b.primeTokens;
    errors.push(...a.errors, ...b.errors);
  }

  const mOn = median(on);
  const mOff = median(off);
  const verdict = mOn <= mOff ? "prime WINS " : "prime loses";
  console.log(
    `  prefix=${String(prefix).padStart(5)}  on=${String(mOn).padStart(6)}ms  ` +
      `off=${String(mOff).padStart(6)}ms  ${(mOff / mOn).toFixed(2)}x  ${verdict}` +
      (errors.length ? `  (${errors.length} ERRORS: ${errors[0]})` : ""),
  );
}

for (const q of [6, 20]) {
  console.log(`\nQ=${q}`);
  for (const k of [0, 2, 5, 10, 20, 40, 80]) await compare(k, q);
}
