import { initCli } from "../src/config.ts";
import { evaluate } from "../src/evaluate.ts";
import { answerQuestion } from "../src/primitives.ts";
import { buildMessages, scoreUserContent } from "../src/prompt.ts";

initCli();

const req = await Bun.file(
  new URL("../examples/triage-request.json", import.meta.url),
).json();

const state = req.state;
const frustration = req.questions.find((q: any) => q.id === "frustration");

const p = (a: any) =>
  ["calm", "mildly frustrated", "very frustrated"]
    .map((k) => `${k}=${(a.probabilities[k] ?? 0).toFixed(6)}`)
    .join("  ");

console.log("=== prompt format: per-question (frustration only) ===");
console.log(buildMessages(state, scoreUserContent(frustration.prompt, frustration.levels))[1]!.content);

console.log("\n=== prompt format: single-pass list (all six) ===");
{
  const lines = req.questions.map(
    (q: any, i: number) =>
      `${i + 1}. ${q.prompt ?? q.statement} [${(q.options ?? q.levels ?? ["yes", "no"]).join(" | ")}]`,
  );
  console.log(
    [
      "Answer every question using exactly one of its options.",
      "Write one answer per line, in the same order as the questions.",
      "",
      ...lines,
    ].join("\n"),
  );
}

console.log("\n=== determinism: per-question alone, 3 sequential runs ===");
for (let i = 0; i < 3; i++) {
  const a = await answerQuestion(state, frustration);
  console.log(`  run ${i + 1}  ${p(a)}  value=${a.value}`);
}

console.log("\n=== determinism: per-question all six (concurrency 2), 3 runs ===");
for (let i = 0; i < 3; i++) {
  const out = await evaluate({ state, questions: req.questions });
  const a = out.answers.find((x: any) => x.id === "frustration")!;
  console.log(`  run ${i + 1}  ${p(a)}  value=${a.value}`);
}

console.log("\n=== determinism: single-pass alone, 3 runs ===");
for (let i = 0; i < 3; i++) {
  const out = await evaluate({
    state,
    questions: [frustration],
    options: { mode: "single-pass" },
  });
  console.log(`  run ${i + 1}  ${p(out.answers[0])}  value=${out.answers[0]!.value}`);
}
