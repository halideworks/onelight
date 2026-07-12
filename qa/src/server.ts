/* Minimal static file server with single-range HTTP Range support. Both the
   <video> element and mediabunny's UrlSource issue Range requests against
   the progressive MP4 fixtures, so a naive static server is not enough. */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".mp4": "video/mp4",
};

export interface StaticServer {
  baseUrl: string;
  close: () => Promise<void>;
}

export const startStaticServer = async (
  rootDir: string,
): Promise<StaticServer> => {
  const server = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const relative = path
        .normalize(decodeURIComponent(url.pathname))
        .replace(/^([/\\]|\.\.)+/, "");
      const filePath = path.join(rootDir, relative);
      if (!filePath.startsWith(rootDir)) {
        response.writeHead(403).end();
        return;
      }
      let info;
      try {
        info = await stat(filePath);
      } catch {
        response.writeHead(404).end();
        return;
      }
      if (!info.isFile()) {
        response.writeHead(404).end();
        return;
      }
      const headers: Record<string, string> = {
        "Content-Type":
          CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream",
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      };
      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");
      const rangeFrom = range?.[1] ?? "";
      const rangeTo = range?.[2] ?? "";
      if (range && (rangeFrom !== "" || rangeTo !== "")) {
        const start =
          rangeFrom === "" ? info.size - Number(rangeTo) : Number(rangeFrom);
        const end =
          rangeFrom !== "" && rangeTo !== ""
            ? Math.min(Number(rangeTo), info.size - 1)
            : info.size - 1;
        if (start < 0 || start > end || start >= info.size) {
          response
            .writeHead(416, { "Content-Range": `bytes */${info.size}` })
            .end();
          return;
        }
        headers["Content-Range"] = `bytes ${start}-${end}/${info.size}`;
        headers["Content-Length"] = String(end - start + 1);
        response.writeHead(206, headers);
        if (request.method === "HEAD") response.end();
        else createReadStream(filePath, { start, end }).pipe(response);
        return;
      }
      headers["Content-Length"] = String(info.size);
      response.writeHead(200, headers);
      if (request.method === "HEAD") response.end();
      else createReadStream(filePath).pipe(response);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
};
