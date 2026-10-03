import { initCli } from "../src/config.ts";

/**
 * Compare s1 (pinned generic LLM) against a native decision model that speaks
 * the same TypeSafe /v1/systemone contract (laya, clef, clef-flash, ...).
 *
 * Usage:
 *   bun run scripts/bench-vs-native.ts                     # NATIVE_MODEL=clef (default)
 *   NATIVE_MODEL=clef-flash bun run scripts/bench-vs-native.ts
 *   NATIVE_MODEL=laya       bun run scripts/bench-vs-native.ts
 *
 * Both endpoints are hit with the identical examples/triage-request.json. s1 is
 * measured in per-question and single-pass modes; the native model in its one
 * forward pass. Answer agreement is reported per question (s1 per-question vs
 * native), with score questions compared on expected level index (±0.5).
 */

initCli();

const req = await Bun.file(
  new URL("../examples/triage-request.json", import.meta.url),
).json();

const NATIVE_MODEL = process.env.NATIVE_MODEL ?? "clef";
const S1 = "http://localhost:8090/v1/systemone";
const NATIVE = `http://localhost:8080/upstream/${NATIVE_MODEL}/v1/systemone`;
const NATIVE_LABEL = `${NATIVE_MODEL} (native decision model)`;

async function post(url: string, body: unknown): Promise<any> {
  const t0 = performance.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const ms = performance.now() - t0;
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { ms, status: res.status, json };
}

function fmtProb(a: any): string {
  const probs: Record<string, number> = a.probabilities ?? {};
  return Object.entries(probs)
    .sort((x, y) => y[1] - x[1])
    .map(([k, v]) => `${k}=${Number(v).toFixed(3)}`)
    .join(" ");
}

function summarize(label: string, r: { ms: number; status: number; json: any }) {
  if (r.status !== 200) {
    console.log(`\n### ${label} -> HTTP ${r.status}\n${JSON.stringify(r.json, null, 2)}`);
    return;
  }
  const { json } = r;
  const answers = json.answers ?? {};
  console.log(`\n### ${label}`);
  console.log(`  model=${json.model}  mode=${json.mode ?? "native"}  http=${r.status}  wall=${r.ms.toFixed(0)}ms`);
  if (json.timing) console.log(`  calls=${json.timing.calls}  totalMs=${json.timing.totalMs}  primeTokens=${json.timing.primeTokens ?? "-"}`);
  if (json.usage) console.log(`  input_tokens=${json.usage.input_tokens}  output_tokens=${json.usage.output_tokens}`);
  for (const [id, a] of Object.entries(answers)) {
    const x = a as any;
    const value = x.choice ?? x.value ?? (x.noul != null ? `noul=${Number(x.noul).toFixed(3)}` : `score=${Number(x.score).toFixed(3)}`);
    const avail = x.probabilitiesAvailable ?? true;
    const probStr = avail ? fmtProb(x) : "(probs unavailable: spec-decode)";
    console.log(`  ${id.padEnd(18)} ${String(value).padEnd(28)} conf=${Number(x.confidence ?? 0).toFixed(3)}  ${probStr}`);
  }
}

// Warm both once (cold start / cache), then measure.
await post(S1, req);
await post(NATIVE, req);

console.log("\n========== WARM RUN ==========");
const s1Per = await post(S1, req);
const s1Single = await post(S1, { ...req, options: { mode: "single-pass" } });
const native = await post(NATIVE, req);

summarize("s1 + deepseek (per-question)", s1Per);
summarize("s1 + deepseek (single-pass)", s1Single);
summarize(NATIVE_LABEL, native);

// Answer agreement: s1 per-question vs native
console.log("\n========== ANSWER AGREEMENT (s1 per-question vs native) ==========");
const s1a = s1Per.json.answers ?? {};
const nativeA = native.json.answers ?? {};
for (const [id, na] of Object.entries(nativeA)) {
  const sa = (s1a as any)[id] as any;
  const nv = (na as any);
  if (!sa) { console.log(`  ${id.padEnd(18)} native=${JSON.stringify(nv.choice ?? nv.value)}  (no s1 answer)`); continue; }
  const s1v = sa.choice ?? sa.value ?? (sa.noul != null ? `noul=${Number(sa.noul).toFixed(3)}` : `score=${Number(sa.score).toFixed(3)}`);
  const nativev = nv.choice ?? nv.value ?? (nv.noul != null ? `noul=${Number(nv.noul).toFixed(3)}` : `score=${Number(nv.score).toFixed(3)}`);
  const match = s1v === nativev || (sa.noul != null && nv.noul != null && Math.abs(sa.noul - nv.noul) < 0.1) || (sa.score != null && nv.score != null && Math.abs(sa.score - nv.score) < 0.5);
  console.log(`  ${id.padEnd(18)} s1=${String(s1v).padEnd(24)} native=${String(nativev).padEnd(24)} ${match ? "same" : "DIFF"}`);
}
