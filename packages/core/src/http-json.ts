import http, { type IncomingMessage, type ServerResponse } from "node:http";

/**
 * Loose request body shape produced by `readBody`. We attempt JSON.parse and
 * fall back to either a form-encoded record or `{ raw }`, so handlers cannot
 * rely on a fixed schema and should narrow what they read.
 */
export type JsonHttpBody = Record<string, unknown> & { raw?: string };

export interface JsonHttpHandlerArgs {
  req: IncomingMessage;
  url: URL;
  body: JsonHttpBody;
  rawBody: string;
}

export type JsonHttpHandlerResult =
  | { ok?: boolean; status?: number; body?: unknown; raw?: undefined }
  | { status?: number; raw: Buffer | string; contentType?: string }
  | Record<string, unknown>
  | undefined
  | void;

export type JsonHttpHandler = (
  args: JsonHttpHandlerArgs,
) => Promise<JsonHttpHandlerResult> | JsonHttpHandlerResult;

export interface JsonHttpServerOptions {
  name: string;
  port: number;
  routes: Record<string, JsonHttpHandler>;
}

async function readBody(req: IncomingMessage): Promise<{ body: JsonHttpBody; rawBody: string }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return { body: {}, rawBody: raw };
  const contentType = String(req.headers["content-type"] || "");
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return {
      body: Object.fromEntries(new URLSearchParams(raw)) as JsonHttpBody,
      rawBody: raw,
    };
  }
  try {
    const parsed = JSON.parse(raw) as JsonHttpBody;
    return { body: parsed, rawBody: raw };
  } catch {
    return { body: { raw }, rawBody: raw };
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body, null, 2));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.length,
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-slack-request-timestamp,x-slack-signature",
    "access-control-allow-private-network": "true",
  });
  res.end(payload);
}

function sendRaw(
  res: ServerResponse,
  status: number,
  body: Buffer | string | undefined,
  contentType = "application/octet-stream",
): void {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ""));
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": payload.length,
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-slack-request-timestamp,x-slack-signature",
    "access-control-allow-private-network": "true",
  });
  res.end(payload);
}

export function createJsonServer({ name, port, routes }: JsonHttpServerOptions) {
  const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type,x-slack-request-timestamp,x-slack-signature",
        "access-control-allow-private-network": "true",
      });
      res.end();
      return;
    }
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const key = `${req.method || "GET"} ${url.pathname}`;
    const handler: JsonHttpHandler | undefined =
      routes[key] ||
      Object.entries(routes).find(([route]) => {
        return route.endsWith("*") && key.startsWith(route.slice(0, -1));
      })?.[1];
    if (!handler) {
      sendJson(res, 404, { ok: false, error: "not_found", service: name, route: key });
      return;
    }
    try {
      const { body, rawBody } = await readBody(req);
      const result = (await handler({ req, url, body, rawBody })) as
        | (Record<string, unknown> & {
            raw?: Buffer | string;
            status?: number;
            contentType?: string;
            body?: unknown;
          })
        | undefined;
      if (result?.raw !== undefined) {
        sendRaw(res, result.status || 200, result.raw, result.contentType);
        return;
      }
      sendJson(res, result?.status || 200, result?.body ?? result ?? { ok: true });
    } catch (error) {
      const err = error as { message?: string };
      sendJson(res, 500, {
        ok: false,
        error: "handler_failed",
        detail: String(err?.message || error),
      });
    }
  });

  return {
    server,
    listen(): Promise<http.Server> {
      return new Promise((resolve) => {
        server.listen(port, "0.0.0.0", () => {
          console.log(`[${name}] listening on http://0.0.0.0:${port}`);
          resolve(server);
        });
      });
    },
  };
}
