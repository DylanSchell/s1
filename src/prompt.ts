import type { ChatMessage } from "./llama.ts";

export function serializeState(state: unknown): string {
  if (typeof state === "string") return state;
  return JSON.stringify(state, null, 2);
}

/** `instructions` may be a string, object or array — serialize non-strings. */
export function serializeInstructions(v: unknown): string {
  if (typeof v === "string") return v;
  return JSON.stringify(v, null, 2);
}

const SYSTEM = [
  "You are a precise classifier.",
  "Read the STATE and answer the QUESTION.",
  "Respond with exactly one of the allowed answers, and nothing else.",
].join(" ");

export function buildMessages(state: unknown, userContent: string): ChatMessage[] {
  return [
    { role: "system", content: `${SYSTEM}\n\nSTATE:\n${serializeState(state)}` },
    { role: "user", content: userContent },
  ];
}

export function noulUserContent(instructions: unknown): string {
  return `${serializeInstructions(instructions)}\nAnswer true or false:`;
}

export function choiceUserContent(instructions: unknown, options: string[]): string {
  return `${serializeInstructions(instructions)}\nChoose exactly one of: ${options.join(", ")}.\nAnswer:`;
}

export function scoreUserContent(instructions: unknown, levels: string[]): string {
  return `${serializeInstructions(instructions)}\nRate on this ordered scale: ${levels.join(" < ")}.\nAnswer:`;
}
