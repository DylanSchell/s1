import { initCli } from "../src/config.ts";
import { evaluate } from "../src/evaluate.ts";
import { answerQuestion, type Question } from "../src/primitives.ts";
import { buildMessages, scoreUserContent, serializeInstructions } from "../src/prompt.ts";

initCli();

const req = await Bun.file(
  new URL("../examples/triage-request.json", import.meta.url),
).json();

const state = req.state;
const questions: Question[] = Object.entries(req.questions).map(([id, q]: [string, any]) => ({
  ...q,
  id,
}));
const frustration = questions.find((q) => q.id === "frustration")!;

const p = (a: any) =>
  ["calm", "mildly frustrated", "very frustrated"]
    .map((k) => `${k}=${(a.probabilities[k] ?? 0).toFixed(6)}`)
    .join("  ");

console.log("=== prompt format: per-question (frustration only) ===");
console.log(buildMessages(state, scoreUserContent(frustration.instructions, ["calm", "mildly frustrated", "very frustrated"]))[1]!.content);

console.log("\n=== prompt format: single-pass list (all six) ===");
{
  const lines = questions.map((q: any, i: number) => `${i + 1}. ${questionLabelsForList(q)}`);
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
  const a = out.answers["frustration"]!;
  console.log(`  run ${i + 1}  ${p(a)}  value=${a.value}`);
}

console.log("\n=== determinism: single-pass alone, 3 runs ===");
for (let i = 0; i < 3; i++) {
  const out = await evaluate({
    state,
    questions: { frustration },
    options: { mode: "single-pass" },
  });
  console.log(`  run ${i + 1}  ${p(out.answers["frustration"])}  value=${out.answers["frustration"]!.value}`);
}

function questionLabelsForList(q: any): string {
  const instr = serializeInstructions(q.instructions);
  switch (q.type) {
    case "noul":
      return `${instr} [true | false]`;
    case "choice":
      return `${instr} [${Object.keys(q.criteria).join(" | ")}]`;
    case "score":
      return `${instr} [ordered scale: ${q.criteria.join(" < ")}]`;
    default:
      return instr;
  }
}
