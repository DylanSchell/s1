import { config, initCli } from "../src/config.ts";
import { evaluate } from "../src/evaluate.ts";

initCli();

const req = await Bun.file(
  new URL("../examples/triage-request.json", import.meta.url),
).json();

for (const mode of ["per-question", "single-pass"] as const) {
  const out = await evaluate({ ...req, options: { mode } });
  const sig = out.answers
    .map((a) => `${a.id}=${a.value}@${a.totalRaw.toFixed(4)}`)
    .join("  ");
  console.log(`nProbs=${String(config.nProbs).padStart(4)}  ${mode.padEnd(13)} calls=${out.timing.calls}  ${sig}`);
}
