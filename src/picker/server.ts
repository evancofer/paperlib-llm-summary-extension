import { randomBytes } from "crypto";
import { createReadStream, existsSync } from "fs";
import http from "http";
import { AddressInfo } from "net";
import path from "path";

/** How long an unanswered picker stays open before it counts as cancelled. */
const TIMEOUT_MS = 60 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;

const ASSETS: Record<string, string> = {
  "picker.js": "text/javascript",
  "pdf.min.mjs": "text/javascript",
  "pdf.worker.min.mjs": "text/javascript",
};

export interface PickerOptions {
  pdfPath: string;
  title: string;
  /** Estimated tokens per page. A promise, as it shouldn't hold up the window. */
  pageTokens: Promise<Record<number, number>>;
  maxTokens: number;
  /** Folder holding the page's scripts. */
  assetDir: string;
  /** Folder holding pdf.js's character maps. */
  cmapDir: string;
}

export interface PickerServer {
  /** Everything on the server sits under this URL, which includes a secret token. */
  base: string;
  /** Resolves to the chosen page numbers, or null if cancelled. */
  result: Promise<number[] | null>;
  close(): void;
}

/** Keeps page numbers that exist, sorted, with no repeats. */
export function parsePages(body: string): number[] {
  let pages: unknown;
  try {
    pages = (JSON.parse(body) as { pages?: unknown }).pages;
  } catch {
    return [];
  }
  if (!Array.isArray(pages)) return [];
  const valid = pages.filter((p): p is number => Number.isInteger(p) && p > 0);
  return [...new Set(valid)].sort((a, b) => a - b);
}

/**
 * Serves one PDF to the picker window and waits for its answer. The window can't reach
 * the extension directly, as it has no Node access. This listens on the loopback
 * address only, and the random token keeps other local programs and web pages out.
 */
export async function startPickerServer(options: PickerOptions): Promise<PickerServer> {
  const token = randomBytes(16).toString("hex");
  let finish: (pages: number[] | null) => void = () => undefined;
  const result = new Promise<number[] | null>((resolve) => {
    finish = resolve;
  });

  const sendFile = (res: http.ServerResponse, file: string, type: string) => {
    if (!existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": type, "Access-Control-Allow-Origin": "*" });
    createReadStream(file).pipe(res);
  };

  const server = http.createServer((req, res) => {
    const [, sentToken, ...rest] = (req.url ?? "").split("?")[0].split("/");
    const route = rest.join("/");
    if (sentToken !== token) {
      res.writeHead(404).end();
      return;
    }

    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_BODY_BYTES) chunks.push(chunk);
      });
      req.on("end", () => {
        res.writeHead(204, { "Access-Control-Allow-Origin": "*" }).end();
        if (route === "done") finish(parsePages(Buffer.concat(chunks).toString("utf8")));
        else if (route === "cancel") finish(null);
      });
      return;
    }

    if (route === "info") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify({ title: options.title }));
    } else if (route === "tokens") {
      options.pageTokens
        .catch(() => ({}))
        .then((pages) => {
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify({ pages, max: options.maxTokens }));
        });
    } else if (route === "pdf") {
      sendFile(res, options.pdfPath, "application/pdf");
    } else if (route in ASSETS) {
      sendFile(res, path.join(options.assetDir, route), ASSETS[route]);
    } else if (/^cmaps\/[\w-]+\.bcmap$/.test(route)) {
      sendFile(res, path.join(options.cmapDir, path.basename(route)), "application/octet-stream");
    } else {
      res.writeHead(404).end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const timer = setTimeout(() => finish(null), TIMEOUT_MS);

  return {
    base: `http://127.0.0.1:${port}/${token}`,
    result,
    close() {
      clearTimeout(timer);
      finish(null);
      server.close();
      // Otherwise an unfinished PDF download would keep the server alive.
      server.closeAllConnections();
    },
  };
}

/** A local file that starts the page. Windows can't open an http address directly. */
export function pickerStub(base: string): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Choose pages</title></head>
<body><script>window.PICKER_BASE = ${JSON.stringify(base)};</script>
<script type="module" src="${base}/picker.js"></script></body>
</html>
`;
}
