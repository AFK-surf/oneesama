import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";

export interface WorkFixtureServer {
  url: string;
  server: Server;
  close(): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

/** Serves a fixture directory on 127.0.0.1 for deterministic work scenarios. */
export async function startWorkFixtureServer(rootDir: string): Promise<WorkFixtureServer> {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const pathname = url.pathname === "/" ? "/search.html" : url.pathname;
      const relative = normalize(pathname).replace(/^([/\\]|\.\.)+/u, "");
      const filePath = join(rootDir, relative);
      try {
        const body = await readFile(filePath);
        res.writeHead(200, {
          "content-type": CONTENT_TYPES[extname(filePath)] || "application/octet-stream",
          "cache-control": "no-store",
        });
        res.end(body);
      } catch {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    server,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
