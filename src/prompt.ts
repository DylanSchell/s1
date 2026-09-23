import type { ChatMessage } from "./llama.ts";

export function serializeState(state: unknown): string {
  if (typeof state === "string") return state;
  return JSON.stringify(state, null, 2);
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

export function noulUserContent(statement: string): string {
  return `${statement}\nAnswer yes or no:`;
}

export function choiceUserContent(prompt: string, options: string[]): string {
  return `${prompt}\nChoose exactly one of: ${options.join(", ")}.\nAnswer:`;
}

export function scoreUserContent(prompt: string, levels: string[]): string {
  return `${prompt}\nRate on this ordered scale: ${levels.join(" < ")}.\nAnswer:`;
}
