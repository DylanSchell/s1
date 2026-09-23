# s1 — System One evaluation server over llama.cpp

`s1` exposes a Jev-style typed-question API on top of a generic local LLM served by
llama-swap / llama.cpp. It does **not** train or modify a model; it turns
`state + typed questions` into a constrained, probability-bearing answer set.

Model is pinned (default `qwen38-flash-next`) via the llama-swap direct route
`/upstream/{model}/...` so requests never trigger a model swap. Endpoint, model
and the other knobs are CLI flags (and `S1_*` env vars) — see
[README.md](./README.md#start-the-server) for install, start-up and the
`scripts/evaluate.sh` validation flow.

## Contract

```
POST /v1/evaluate
{
  "state": <string | object | array>,
  "questions": [
    { "id": "q1", "type": "noul",   "statement": "The review is positive." },
    { "id": "q2", "type": "choice", "prompt": "Sentiment", "options": ["positive","negative","neutral"] },
    { "id": "q3", "type": "score",  "prompt": "Urgency", "levels": ["none","low","medium","high"] }
  ],
  "options": { "temperature": 1.0, "nProbs": 512, "mode": "per-question" }
}
```

`options.mode` selects the decoding strategy:

| mode | calls | shape |
|---|---|---|
| `per-question` (default) | 1 + shared-prefix nodes per question | independent score per question |
| `single-pass` | **1 for the whole request** | every question answered in one grammar-constrained document |

Response:

```jsonc
{
  "answers": [
    { "id":"q1","type":"noul",  "probability":0.998,"confidence":0.996,"strategy":"raw" },
    { "id":"q2","type":"choice","value":"positive","probabilities":{...},"confidence":0.999,"strategy":"raw" },
    { "id":"q3","type":"score", "value":"medium","score":2.1,"probabilities":{...},"confidence":0.6,"strategy":"raw","calls":1 }
  ],
  "model": "qwen38-flash-next",
  "mode": "per-question",
  "timing": { "totalMs": 123.4, "calls": 3 }
}
```

## Primitives (Jev mapping)

| Jev | s1 `type` | Output |
|---|---|---|
| Choice | `choice` | `value`, `probabilities`, `confidence` |
| Score | `score` | `value`, `score` (expected level, 0..1), `probabilities` |
| Noul | `noul` | `probability` (0..1), `confidence` |

## Scoring core (verified against llama.cpp)

1. Build one shared prefix: system instruction + serialized `state`. Every
   question is a short suffix on top of it. llama.cpp evaluates a prompt from
   scratch unless the *cached* prompt is a prefix of the incoming one, and a
   fan-out of sibling questions shares a head and then diverges — so on its own
   the cache never hits. s1 therefore **primes** the shared prefix with one
   extra call (reported as `timing.primeTokens`) and then asks the questions one
   at a time, which is what makes every one of them reuse it. Priming happens
   whenever there is more than one question; `--prime-min-tokens -1` opts out.
2. Tokenize every surface form of every option (`opt`, `" "+opt`, plus
   capitalized variants — tokenizers treat `yes`/`Yes`/` yes` as distinct tokens).
   Forms are looked up in the *same* distribution, so they cost no extra calls.
3. Build a token trie over the option forms.
4. **One `/completion` at the root** returns the raw next-token distribution
   (`n_probs`, filtered client-side by token id). An option whose trie node belongs
   to exactly one option is committed there; its probability is the mass of the
   shortest prefix that identifies it. That is length-neutral, so multi-word
   options are not penalised for having more tokens.
5. A second (third, …) call is made **only** at nodes where two or more options
   share a token: append that shared prefix via `/detokenize` and re-read.
   Calls = 1 + number of shared-prefix nodes.
6. Normalize option masses → per-option probabilities.
7. Optional calibration: temperature scaling on the probability map.

Verified facts that drive this design:

- `logit_bias` and `grammar` constrain *sampling* but do **not** alter reported
  pre-sampling `top_logprobs`. Only `post_sampling_probs: true` reflects them. So
  promoting option tokens does not change the numbers you read, and a uniform
  promotion cancels under renormalisation.
- `n_probs = N` returns the top-N of a full-vocab softmax; `n_probs = 250000`
  returned all 248,320 entries summing to ~1.0. There is no "probs for these ids"
  parameter — request enough N and filter client-side.
- Surface forms carry real mass: for `"very positive"` the no-leading-space form
  held 0.795 while `" very positive"` held 0.012. Under-counting forms silently
  flips the answer.
- Token-prefix collisions (`"very positive"` / `"very negative"`) are resolved by
  appending the shared prefix and re-reading — one call per shared node, not per
  option.
- `n_probs` only has to reach the *material* option tokens, not every surface
  form. Measured over 152 required-token reads (11 question instances): the
  deepest token with p ≥ 1e-3 sat at rank **9**, so N=16 already covered every
  token that matters. Tokens beyond that are capitalized variants with p ≈ 0
  (`" Negative"` at rank 1448) that no N realistically reaches — and needn't.
  Cost is payload, not compute: latency is flat from N=1 (72.1 ms) to N=512
  (72.4 ms), while the response grows 0.2 KB → 40.8 KB. Default is therefore 64;
  `totalRaw` (option mass before normalisation) is the coverage guard that tells
  you when to raise it.
- Prompt-cache reuse needs the *cached* prompt to be a prefix of the incoming
  one. Measured via `timings.cache_n` on this server (`--kv-unified` +
  `--cache-ram 16384`, so `--cache-idle-slots` saves idle slots and clears their
  KV on every new task): an identical repeat reused all but 4 tokens, a strict
  prefix extension reused 154 of 158, and a sibling prompt sharing 123 tokens
  reused **0**. Sharing a head and then diverging is worth nothing. See
  `scripts/measure-prefix-cache.ts`.

## Single-pass mode

`options.mode = "single-pass"` answers *every* question in one `/completion`
call, using a token-level GBNF grammar emitted from the same option token paths
used by the scorer (`src/singlePass.ts`):

```
root ::= f0 <[newline]> f1 <[newline]> ... <[newline]> fN
f0   ::= <[a]> <[b]> | <[c]>          # one branch per option rendering
...
```

Properties:

- **Conformance is structural.** The grammar admits *only* an option's token
  path at each position, so a returned value can never be off-schema. There is no
  post-hoc validation and no repair pass.
- **One call.** All fields share a single forward pass; `timing.calls` is `1` and
  each `answer.calls` is `0` (the call is shared, not attributable to one
  question).
- **Exact field location.** Every token — scaffolding and values — is pinned by
  id, so the generated stream is fully determined by the per-field choices. Fields
  are split on the newline token and each segment is matched against its option
  paths, giving the value directly (no string re-parsing).
- **Per-field probabilities are best-effort.** They come from the *raw*
  (grammar-ignorant) next-token read at each field's first token, so they are
  exact when options start with distinct tokens and lump the shared prefix
  otherwise. They are also **contextual**: a field is conditioned on the rest of
  the question list and on the answers already written for earlier fields, so the
  numbers differ from `per-question` even when the argmax agrees.
- **The prompt must keep each question's type signal.** `score` questions are
  rendered `[ordered scale: low < medium < high]` and `noul` as `[yes | no]`;
  rendering levels as `[low | medium | high]` reads as *unordered* and makes the
  model hedge to the middle level. Measured on the triage example: flattening the
  scale to `|` moved `frustration` from `very frustrated` (0.85) to
  `mildly frustrated` (0.59); restoring `<` returned `very frustrated` (0.66) and
  took agreement with `per-question` from 5/6 to 6/6.
- **No shared-prefix calls needed.** Collisions that force a trie walk in
  `per-question` mode cost nothing here: the grammar resolves them inside the one
  generation.

Measured on `examples/triage-request.json` (6 questions): per-question = 6 calls /
~1.7 s, single-pass = **1 call / ~0.6 s**.

## Prefix priming (per-question mode)

Measured through the public API with 6 questions, priming merely toggled
(`scripts/measure-prime-e2e.ts`):

| state | shared prefix | off | on | |
|---|---|---|---|---|
| triage example | 66 tok | 1825 ms | 1804 ms | 1.01x |
| synthetic | ~1340 tok | 10,209 ms | 3440 ms | 2.97x |

Answers are identical in both cases. On the large state prefill drops from
12,797 to 2,206 tokens.

**Priming is never gated on prefix length.** It costs one prefill of `L` tokens
and saves `L` tokens on each of the `Q` questions, so the net saving is
`L x (Q - 1)` — positive for any `Q >= 2` and any `L > 0`. There is no length
below which caching stops working; llama.cpp has no such minimum. So s1 primes
whenever a request needs more than one call, and `--prime-min-tokens -1` only
exists as an explicit opt-out. Short prefixes are *neutral* rather than harmful:
66 tokens of extra prefill buys the same back on each of the five remaining
questions; the win only becomes large once the shared prefix dominates the
prompt.

Two conditions make priming work:

1. the prime is issued and awaited *before* any question is scored, so the
   prefix is already cached; and
2. the questions are then asked **one at a time**. A concurrently dispatched
   question lands on a slot that is busy rebuilding its own prefix, and
   llama.cpp can only restore a cached prompt into an idle slot. Measured:
   serial + primed reused the prefix for all 6 questions, concurrent + primed
   for only 3.

Known limitation: serialisation only guarantees slot locality while s1 is the
only traffic. Two `evaluate` calls in flight at once can interleave across the
`--parallel` slots and lose part of the reuse.

## Default posture

A single raw read per question when first tokens are distinct; a trie walk fires
additional calls only at shared-prefix nodes. `confidence` is the top probability;
`margin` is top-minus-second; `totalRaw` is the unnormalised coverage/abstain
signal; `calls` reports the forward passes used.

## Non-goals / v2

- Calibration. Generic LLM next-token probabilities are **not calibrated** (Jev
  uses RLCD). The `temperature` hook is a placeholder; proper Platt/isotonic
  calibration needs labelled data.
- Full-sequence (teacher-forced) likelihood as an alternative to shortest-unique
  prefix scoring, if a use case needs it.
- Numeric / free-text answers. Both modes are closed-schema: `single-pass` can
  only emit option token paths, `per-question` only renormalises over options.
