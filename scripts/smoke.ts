import { initCli } from "../src/config.ts";
import { evaluate } from "../src/evaluate.ts";

initCli();

const out = await evaluate({
  state: {
    review: "This product exceeded my expectations. Shipping was slow though.",
    user: { name: "Dylan", plan: "pro" },
  },
  questions: [
    { id: "positive", type: "noul", statement: "The review is positive overall." },
    { id: "shipping", type: "noul", statement: "The customer complains about shipping." },
    {
      id: "sentiment",
      type: "choice",
      prompt: "Overall sentiment",
      options: ["positive", "negative", "neutral"],
    },
    {
      id: "urgency",
      type: "score",
      prompt: "How urgently should support follow up?",
      levels: ["none", "low", "medium", "high"],
    },
  ],
});

console.log(JSON.stringify(out, null, 2));
