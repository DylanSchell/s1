import { config, initCli } from "./config.ts";
import { evaluate, type EvaluateRequest } from "./evaluate.ts";

initCli();

const server = Bun.serve({
  port: config.port,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, model: config.model });
    }

    if (url.pathname === "/v1/evaluate") {
      if (req.method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }
      let body: EvaluateRequest;
      try {
        body = (await req.json()) as EvaluateRequest;
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      try {
        return Response.json(await evaluate(body));
      } catch (e) {
        return Response.json(
          { error: e instanceof Error ? e.message : String(e) },
          { status: 400 },
        );
      }
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(
  `s1 listening on :${server.port}  model=${config.model}  ` +
    `upstream=${config.baseUrl}/upstream/${config.model}  concurrency=${config.concurrency}`,
);
