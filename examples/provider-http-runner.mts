#!/usr/bin/env node

import http from "node:http";

const port = Number(process.env.PORT || 19090);

const server = http.createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/agent/run") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: "not_found" }));
    return;
  }

  let body = "";
  for await (const chunk of request) {
    body += chunk;
  }

  const payload = JSON.parse(body || "{}");
  const task = payload.task || payload.prompt || "empty task";
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      status: "completed",
      result: `HTTP provider received: ${task}`,
    }),
  );
});

server.listen(port, "127.0.0.1", () => {
  console.log(`provider-http-runner listening on http://127.0.0.1:${port}/agent/run`);
});
