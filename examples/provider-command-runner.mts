#!/usr/bin/env node

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});

process.stdin.on("end", () => {
  const payload = JSON.parse(input || "{}");
  const task = payload.task || payload.prompt || "empty task";
  process.stdout.write(
    JSON.stringify({
      status: "completed",
      result: `Command provider received: ${task}`,
    }),
  );
});
