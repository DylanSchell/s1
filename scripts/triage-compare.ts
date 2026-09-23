import { initCli } from "../src/config.ts";
import { evaluate } from "../src/evaluate.ts";

initCli();

const req = await Bun.file(
  new URL("../examples/triage-request.json", import.meta.url),
).json();

function brief(label: string, out: Awaited<ReturnType<typeof evaluate>>) {
  console.log(`\n== ${label} (${out.mode}) calls=${out.timing.calls} ${out.timing.totalMs}ms`);
  for (const a of out.answers) {
    const probs = Object.entries(a.probabilities)
      .sort((x, y) => y[1] - x[1])
      .map(([k, v]) => `${k}=${v.toFixed(3)}`)
      .join(" ");
    console.log(
      `  ${a.id.padEnd(16)} ${String(a.value).padEnd(22)} conf=${a.confidence.toFixed(3)} ${a.strategy}` +
        (a.error ? ` ERROR=${a.error}` : "") +
        `\n      ${probs}`,
    );
  }
}

brief("per-question", await evaluate(req));
brief("single-pass", await evaluate({ ...req, options: { mode: "single-pass" } }));

const [per, single] = [
  await evaluate(req),
  await evaluate({ ...req, options: { mode: "single-pass" } }),
];
console.log("\n== agreement");
for (const a of per.answers) {
  const b = single.answers.find((x) => x.id === a.id)!;
  console.log(`  ${a.id.padEnd(16)} ${a.value === b.value ? "same" : `DIFF per=${a.value} single=${b.value}`}`);
}
