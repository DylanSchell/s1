import { initCli } from "../src/config.ts";
import { evaluate } from "../src/evaluate.ts";
import { answerQuestion } from "../src/primitives.ts";

initCli();

const req = await Bun.file(
  new URL("../examples/triage-request.json", import.meta.url),
).json();

const state = req.state;
const frustration = req.questions.find((q: any) => q.id === "frustration");
const others = req.questions.filter((q: any) => q.id !== "frustration");

function show(label: string, a: any) {
  const probs = Object.entries(a.probabilities)
    .sort((x: any, y: any) => y[1] - x[1])
    .map(([k, v]: any) => `${k}=${v.toFixed(6)}`)
    .join("  ");
  console.log(
    `${label}  value=${String(a.value).padEnd(18)} ` +
      `totalRaw=${a.totalRaw.toFixed(6)}  calls=${a.calls}\n    ${probs}`,
  );
}

// A — per-question, frustration alone (baseline)
show("A per-question alone       ", await answerQuestion(state, frustration));

// B — single-pass, frustration alone (isolates prompt-format effect, no prior answers)
{
  const out = await evaluate({ state, questions: [frustration], options: { mode: "single-pass" } });
  show("B single-pass alone        ", out.answers[0]);
}

// C — single-pass, all six in declared order (adds autoregressive prior answers)
{
  const out = await evaluate({ state, questions: req.questions, options: { mode: "single-pass" } });
  show("C single-pass all (order)  ", out.answers.find((a: any) => a.id === "frustration"));
}

// D — single-pass, frustration FIRST then the rest (prior answers exist, but not its own)
{
  const out = await evaluate({
    state,
    questions: [frustration, ...others],
    options: { mode: "single-pass" },
  });
  show("D single-pass first        ", out.answers.find((a: any) => a.id === "frustration"));
}

// E — per-question, all six fanned out (should equal A: raw logits are deterministic)
{
  const out = await evaluate({ state, questions: req.questions });
  show("E per-question all         ", out.answers.find((a: any) => a.id === "frustration"));
}
