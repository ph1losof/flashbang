import { parseCookie } from "../src/suggest";

const distIndex = Bun.file("dist/index.html");
if (!(await distIndex.exists())) {
  console.error("dist/index.html not found. Run `bun run build` first.");
  process.exit(1);
}

async function serveCompressed(req: Request, filePath: string, extraHeaders?: Record<string, string>) {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;

  const accept = req.headers.get("accept-encoding") ?? "";
  const contentType = file.type;

  if (accept.includes("br")) {
    const br = Bun.file(`${filePath}.br`);
    if (await br.exists()) {
      return new Response(br, {
        headers: { "Content-Encoding": "br", "Content-Type": contentType, ...extraHeaders },
      });
    }
  }

  return new Response(file, extraHeaders ? { headers: extraHeaders } : undefined);
}

const port = Number(process.env.PORT) || 3000;
console.log(`Production server: http://localhost:${port}`);

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/suggest" && url.searchParams.get("q")) {
      const { suggest } = await import("../src/suggest");
      return suggest(url.searchParams.get("q")!, parseCookie(req));
    }

    if (url.pathname === "/opensearch.xml") {
      const { opensearch } = await import("../src/opensearch");
      return opensearch(url.origin);
    }

    if (url.pathname === "/bench") {
      return (await serveCompressed(req, "dist/bench.html", {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "credentialless",
      }))!;
    }

    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const fromDist = await serveCompressed(req, `dist${path}`);
    if (fromDist) return fromDist;

    const fromHtml = await serveCompressed(req, `dist${path}.html`);
    if (fromHtml) return fromHtml;

    return (await serveCompressed(req, "dist/index.html"))!;
  },
});
