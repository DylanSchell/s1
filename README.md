# s1

System One evaluation server. It turns `state + typed questions` into
constrained, probability-bearing answers using a generic local LLM served by
llama-swap / llama.cpp — no training, no fine-tuning, no model modification.

The model is **pinned** per request (via llama-swap's direct
`/upstream/{model}/...` route), so serving traffic never triggers a model swap.

The design, the verified llama.cpp mechanics behind it, and the API schema live
in [SPEC.md](./SPEC.md).

## Prerequisites

- **Bun** ≥ 1.1 (developed against 1.4): `bun --version`.
- **jq** — required by the validation script.
- **llama-swap** or llama.cpp's server running with the model you intend to use
  already loaded. Defaults assume `http://localhost:8080` and model id
  `qwen38-flash-next`.

Confirm the model endpoint is reachable before starting s1:

```bash
curl -s http://localhost:8080/upstream/qwen38-flash-next/props | head -c 200
```

## Build / install

```bash
bun install
bunx tsc --noEmit   # typecheck (no model needed)
bun test            # unit tests (no model needed)
```

## Start the server

```bash
bun run start
```

Point it at a different endpoint or model with flags:

```bash
bun run src/server.ts --base-url http://localhost:8081 --model my-model --port 8090

# same, via the npm script (note the `--`)
bun run start -- --base-url http://localhost:8081 --model my-model
```

| Flag | Env var | Default | Meaning |
|---|---|---|---|
| `-u, --base-url <url>` | `S1_BASE_URL` | `http://localhost:8080` | llama-swap base URL |
| `-m, --model <id>` | `S1_MODEL` | `qwen38-flash-next` | pinned model identifier |
| `-p, --port <n>` | `S1_PORT` | `8090` | HTTP port s1 listens on |
| `-c, --concurrency <n>` | `S1_CONCURRENCY` | `2` | max in-flight completions (match llama.cpp `--parallel`) |
| `-t, --timeout-ms <n>` | `S1_TIMEOUT_MS` | `180000` | per-request timeout |
| `-n, --n-probs <n>` | `S1_N_PROBS` | `64` | top-N tokens returned per distribution read |
| `--prime-min-tokens <n>` | `S1_PRIME_MIN_TOKENS` | `0` | prime the shared prefix for KV reuse; `0` = always, negative = never |

CLI flags override the environment variables, which override the defaults.
`--help` prints the same table.

On start-up the server prints the resolved configuration:

```
s1 listening on :8090  model=qwen38-flash-next  upstream=http://localhost:8080/upstream/qwen38-flash-next  concurrency=2
```

## Validate that it works

### 1. Health check

```bash
curl -s http://localhost:8090/health
# {"ok":true,"model":"qwen38-flash-next"}
```

### 2. End-to-end with `scripts/evaluate.sh`

This is the quickest way to prove the whole path (HTTP → prompt → llama.cpp →
constrained answer) works. The script:

1. probes `GET /health` and fails early if s1 is not running,
2. `POST`s a request file to `/v1/evaluate`,
3. pretty-prints the JSON response with `jq`,
4. exits non-zero if the API returned an error.

```bash
bash scripts/evaluate.sh
```

It defaults to `examples/triage-request.json` against `http://localhost:8090`.
Both can be overridden:

```bash
bash scripts/evaluate.sh examples/triage-request.json                      # explicit request file
bash scripts/evaluate.sh examples/triage-request.json http://localhost:8091 # other s1 instance (positional)
S1_URL=http://localhost:8091 bash scripts/evaluate.sh                       # other s1 instance (env)
```

Expected shape (values depend on your model):

```jsonc
{
  "answers": [
    { "id": "queue", "type": "choice", "value": "Account access support", "confidence": 1.0, "strategy": "raw", "calls": 1 },
    { "id": "can_sign_in", "type": "noul", "value": "no", "probability": 0.0014, "confidence": 0.997, "strategy": "raw" }
    // ...
  ],
  "model": "qwen38-flash-next",
  "mode": "per-question",
  "timing": { "totalMs": 1513, "calls": 6 }
}
```

To validate **single-pass** mode (every question answered in one model call),
flip the mode in the request and re-run:

```bash
jq '.options = {mode:"single-pass"}' examples/triage-request.json > /tmp/single-pass.json
bash scripts/evaluate.sh /tmp/single-pass.json
# expect: "mode": "single-pass", "timing": { "calls": 1 }
```

### 3. Live integration tests

The integration tests are opt-in and hit the real model:

```bash
S1_LIVE=1 bun test
```

They assert the pinned model id, that no answer errors out, that distinct
first-token options resolve in one call, that shared-prefix options walk the
trie, and that `single-pass` and `per-question` agree.

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness check and the pinned model id. |
| `POST` | `/v1/evaluate` | Score typed questions against a caller-supplied state. |

Request and response schemas, the `choice` / `score` / `noul` primitives, and
the `options.mode` switch are documented in
[SPEC.md](./SPEC.md#contract) and [SPEC.md](./SPEC.md#single-pass-mode).

## Project layout

```
src/
  config.ts      flags/env parsing, base URL, the pinned model
  llama.ts       llama.cpp client (/tokenize, /detokenize, /apply-template, /completion)
  options.ts     option surface forms + token paths + token trie
  grammar.ts     GBNF helpers, including token-id primitives
  prompt.ts      state serialization and per-question user content
  scoring.ts     per-question scoring (shortest-unique-prefix trie walk)
  singlePass.ts  one grammar-constrained call for all questions
  primitives.ts  noul / choice / score, answer assembly
  evaluate.ts    orchestration, per-question error isolation
  server.ts      Bun HTTP server
examples/        sample request payloads
scripts/         evaluate.sh (validation), smoke.ts, triage-compare.ts
test/            unit tests + opt-in live integration tests
```

## Development

```bash
bunx tsc --noEmit                            # typecheck
bun test                                     # unit tests
S1_LIVE=1 bun test                           # + live tests against the model
bun run scripts/smoke.ts                     # one-shot evaluation, prints JSON
bun run compare                              # per-question vs single-pass, side by side
bun run scripts/measure-prefix-cache.ts      # prompt-cache reuse law on this server
bun run scripts/measure-prime-e2e.ts         # run priming off vs on, same answers
```

All of the scripts accept the same flags as the server, e.g.
`bun run scripts/smoke.ts --model my-model`.

## License

[MIT](./LICENSE) © 2026 Dylan Schell
