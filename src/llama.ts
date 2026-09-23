import { config, upstream } from "./config.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface TokenProb {
  id: number;
  token: string;
  logprob: number;
}

export interface CompletionProb extends TokenProb {
  top_logprobs?: TokenProb[];
}

export interface CompletionResponse {
  content: string;
  completion_probabilities?: CompletionProb[];
  timings?: unknown;
}

/** Bounds concurrent *generation* calls to the llama.cpp slot count. */
export class Semaphore {
  private waiters: (() => void)[] = [];
  private active = 0;

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

// Only generation is slot-bound; tokenize/apply-template are cheap and local.
const slots = new Semaphore(config.concurrency);

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(upstream(path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`llama.cpp POST ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  }
  return (await res.json()) as T;
}

export async function tokenize(content: string): Promise<number[]> {
  const r = await postJson<{ tokens: number[] }>("/tokenize", {
    content,
    add_special: false,
  });
  return r.tokens;
}

export async function detokenize(tokens: number[]): Promise<string> {
  const r = await postJson<{ content: string }>("/detokenize", { tokens });
  return r.content;
}

export async function applyTemplate(
  messages: ChatMessage[],
  kwargs: Record<string, unknown> = {},
): Promise<string> {
  const r = await postJson<{ prompt: string }>("/apply-template", {
    messages,
    chat_template_kwargs: kwargs,
  });
  return r.prompt;
}

export async function completion(
  body: Record<string, unknown>,
): Promise<CompletionResponse> {
  const payload = {
    temperature: 1.0,
    top_k: 0,
    top_p: 1.0,
    post_sampling_probs: false,
    ...body,
  };
  return slots.run(() => postJson<CompletionResponse>("/completion", payload));
}

export interface Props {
  default_generation_settings?: { n_ctx?: number };
  model_alias?: string;
  total_slots?: number;
  [key: string]: unknown;
}

export async function props(): Promise<Props> {
  const res = await fetch(upstream("/props"), {
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!res.ok) throw new Error(`llama.cpp GET /props -> ${res.status}`);
  return (await res.json()) as Props;
}
