import { parseArgs } from "node:util";

export interface Config {
  /** llama-swap base URL (OpenAI-compatible front door). */
  baseUrl: string;
  /** Pinned model identifier. Never swapped away from this. */
  model: string;
  /** Max concurrent in-flight completions (match llama.cpp --parallel). */
  concurrency: number;
  /** Per-request timeout. */
  timeoutMs: number;
  /** HTTP port for the s1 server. */
  port: number;
  /**
   * Default n_probs (top-N) requested for each distribution read. Sized from
   * measurement, not guesswork: across 152 required-token reads the deepest
   * token carrying >=1e-3 probability sat at rank 9, so 64 leaves ~7x margin.
   * Latency is flat to ~512; the cost of a larger N is response payload
   * (~1.7 ms and ~80 KB per 1000 extra entries), not compute. `totalRaw` in each
   * answer is the coverage guard: if it drops well below 1, raise this.
   */
  nProbs: number;
  /**
   * Minimum token length of the prefix shared by every question prompt before
   * s1 spends one extra call priming the KV cache with it. llama.cpp only
   * restores a cached prompt when the cached tokens are a prefix of the
   * incoming prompt, so sibling questions (shared state, divergent tails) never
   * hit the cache on their own. `0` disables priming.
   */
  primeMinTokens: number;
}

/**
 * Shared config singleton, seeded from the environment. Entry points call
 * `configureFromArgv` to layer CLI flags on top (CLI > env > default). Readers
 * (`upstream`, `llama.ts`) resolve against this object at call time, so mutation
 * during start-up is safe.
 */
export const config: Config = {
  baseUrl: process.env.S1_BASE_URL ?? "http://localhost:8080",
  model: process.env.S1_MODEL ?? "qwen38-flash-next",
  concurrency: Number(process.env.S1_CONCURRENCY ?? 2),
  timeoutMs: Number(process.env.S1_TIMEOUT_MS ?? 180_000),
  port: Number(process.env.S1_PORT ?? 8090),
  nProbs: Number(process.env.S1_N_PROBS ?? process.env.S1_MAX_PROBS ?? 64),
  primeMinTokens: Number(process.env.S1_PRIME_MIN_TOKENS ?? 128),
};

export function upstream(path: string): string {
  return `${config.baseUrl}/upstream/${encodeURIComponent(config.model)}${path}`;
}

const OPTION_SPEC = {
  "base-url": { type: "string", short: "u" },
  model: { type: "string", short: "m" },
  port: { type: "string", short: "p" },
  concurrency: { type: "string", short: "c" },
  "timeout-ms": { type: "string", short: "t" },
  "n-probs": { type: "string", short: "n" },
  "prime-min-tokens": { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

export const USAGE = `s1 — System One evaluation server

Usage:
  bun run src/server.ts [options]       start the HTTP server
  bun run scripts/smoke.ts [options]    run a one-shot evaluation
  bun run scripts/triage-compare.ts     compare per-question vs single-pass

Options:
  -u, --base-url <url>    llama-swap base URL          [S1_BASE_URL]    default http://localhost:8080
  -m, --model <id>        pinned model identifier      [S1_MODEL]       default qwen38-flash-next
  -p, --port <n>          HTTP port for s1             [S1_PORT]        default 8090
  -c, --concurrency <n>   max in-flight completions    [S1_CONCURRENCY] default 2
  -t, --timeout-ms <n>    per-request timeout (ms)     [S1_TIMEOUT_MS]  default 180000
  -n, --n-probs <n>       top-N per distribution read  [S1_N_PROBS]     default 64
      --prime-min-tokens <n>  min shared prefix to prime [S1_PRIME_MIN_TOKENS] default 128 (0 = off)
  -h, --help              show this help

CLI flags override the S1_* environment variables.`;

export class CliError extends Error {}

function positiveNumber(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CliError(`--${flag} must be a positive number (got "${raw}")`);
  }
  return n;
}

function nonNegativeNumber(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new CliError(`--${flag} must be zero or greater (got "${raw}")`);
  }
  return n;
}

/** Parse s1's CLI flags. Throws {@link CliError} on unknown or malformed input. */
export function parseCli(argv: string[]): {
  help: boolean;
  values: Record<string, string | boolean | undefined>;
} {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: OPTION_SPEC,
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    throw new CliError(e instanceof Error ? e.message : String(e));
  }
  return { help: values.help === true, values };
}

/** Apply parsed CLI values onto the shared config (CLI wins over env). */
export function applyCli(values: Record<string, string | boolean | undefined>): void {
  if (typeof values["base-url"] === "string") {
    config.baseUrl = values["base-url"].replace(/\/+$/, "");
  }
  if (typeof values.model === "string") config.model = values.model;
  if (typeof values.port === "string") config.port = positiveNumber("port", values.port);
  if (typeof values.concurrency === "string") {
    config.concurrency = positiveNumber("concurrency", values.concurrency);
  }
  if (typeof values["timeout-ms"] === "string") {
    config.timeoutMs = positiveNumber("timeout-ms", values["timeout-ms"]);
  }
  if (typeof values["n-probs"] === "string") {
    config.nProbs = positiveNumber("n-probs", values["n-probs"]);
  }
  if (typeof values["prime-min-tokens"] === "string") {
    config.primeMinTokens = nonNegativeNumber("prime-min-tokens", values["prime-min-tokens"]);
  }
}

/** Parse + apply in one step. Returns `help` so callers can print USAGE. */
export function configureFromArgv(argv: string[]): { help: boolean } {
  const { help, values } = parseCli(argv);
  if (!help) applyCli(values);
  return { help };
}

/**
 * Entry-point helper: apply flags, or print usage and exit for `--help` /
 * malformed input. Call once at the top of a process, before serving/asking.
 */
export function initCli(argv: string[] = process.argv.slice(2)): void {
  try {
    if (configureFromArgv(argv).help) {
      console.log(USAGE);
      process.exit(0);
    }
  } catch (e) {
    if (e instanceof CliError) {
      console.error(`error: ${e.message}\n`);
      console.error(USAGE);
      process.exit(2);
    }
    throw e;
  }
}
