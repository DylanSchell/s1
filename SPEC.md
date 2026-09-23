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

1. Build one shared prefix: system instruction + serialized `state`. Each question
   is a short suffix, so llama.cpp's prompt cache (`cache_prompt`, `--cache-ram`)
   reuses the state prefill. Fan-out concurrency matches `--parallel`.
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
