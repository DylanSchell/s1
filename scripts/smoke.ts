import { initCli } from "../src/config.ts";
import { evaluate } from "../src/evaluate.ts";

initCli();

const out = await evaluate({
  state: {
    review: "This product exceeded my expectations. Shipping was slow though.",
    user: { name: "Dylan", plan: "pro" },
  },
  questions: {
    positive: { type: "noul", instructions: "The review is positive overall." },
    shipping: { type: "noul", instructions: "The customer complains about shipping." },
    sentiment: {
      type: "choice",
      instructions: "Overall sentiment",
      criteria: { positive: null, negative: null, neutral: null },
    },
    urgency: {
      type: "score",
      instructions: "How urgently should support follow up?",
      criteria: ["none", "low", "medium", "high"],
    },
  },
});

console.log(JSON.stringify(out, null, 2));
