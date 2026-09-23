import { config, initCli } from "../src/config.ts";
import { evaluate } from "../src/evaluate.ts";

initCli();

const QUESTIONS = [
  { id: "queue", type: "choice" as const, prompt: "Which queue should handle this?", options: ["Account access support", "Billing Support", "Close as resolved"] },
  { id: "cause", type: "choice" as const, prompt: "Which system is the most likely root cause?", options: ["auth", "email", "billing"] },
  { id: "refund", type: "noul" as const, statement: "The customer is asking for a refund." },
  { id: "escalate", type: "noul" as const, statement: "This needs to be escalated to engineering." },
  { id: "outage", type: "noul" as const, statement: "This is part of a wider outage." },
  { id: "urgency", type: "score" as const, prompt: "How urgent is this?", levels: ["low", "medium", "high", "critical"] },
];

function bigState(lines: number) {
  return Array.from(
    { length: lines },
    (_, i) =>
      `Ticket-line ${i + 1}: customer reports intermittent failures on the billing ` +
      `dashboard while the account remains locked, reference ${crypto.randomUUID()}.`,
  ).join("\n");
}

const TRIAGE = (
  await Bun.file(new URL("../examples/triage-request.json", import.meta.url)).json()
).state;

async function timeOnce(state: unknown, minTokens: number) {
  config.primeMinTokens = minTokens;
  const out = await evaluate({ state, questions: QUESTIONS });
  return {
    ms: out.timing.totalMs,
    calls: out.timing.calls,
    primeTokens: out.timing.primeTokens ?? 0,
    values: out.answers.map((a) => `${a.id}=${a.value}`).join(" "),
  };
}

async function bench(label: string, state: unknown, reps = 2) {
  // Flush, so the first measured run is not riding on someone else's cache.
  config.primeMinTokens = -1;
  await evaluate({ state: bigState(200), questions: QUESTIONS });

  const off: number[] = [];
  const on: number[] = [];
  let refValues = "";
  let onValues = "";
  for (let r = 0; r < reps; r++) {
    const s = state;
    const a = await timeOnce(s, -1); // priming disabled
    const b = await timeOnce(s, 0); // priming always on
    off.push(a.ms);
    on.push(b.ms);
    refValues = a.values;
    onValues = b.values;
    console.log(
      `  rep${r + 1}  off: ${String(a.ms).padStart(6)} ms (calls=${a.calls})` +
        `   on: ${String(b.ms).padStart(6)} ms (calls=${b.calls}, primeTokens=${b.primeTokens})`,
    );
  }
  const med = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;
  const speedup = med(off) / med(on);
  const same = refValues === onValues;
  console.log(
    `${label}\n    median off=${med(off)} ms   on=${med(on)} ms   -> ${speedup.toFixed(2)}x` +
      `   answers ${same ? "IDENTICAL" : `DIFFER\n      off: ${refValues}\n      on:  ${onValues}`}`,
  );
}

await bench("SMALL state (triage state, ~66-token shared prefix)", TRIAGE, 3);
await bench("LARGE state (~1400-token shared prefix)", bigState(24), 2);
