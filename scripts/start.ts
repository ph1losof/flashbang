import { parseCookie } from "../src/suggest";

const distIndex = Bun.file("dist/index.html");
if (!(await distIndex.exists())) {
  console.error("dist/index.html not found. Run `bun run build` first.");
  process.exit(1);
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
      return new Response(Bun.file("dist/bench.html"), {
        headers: {
          "Content-Type": "text/html",
          "Cross-Origin-Opener-Policy": "same-origin",
          "Cross-Origin-Embedder-Policy": "credentialless",
        },
      });
    }

    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(`dist${path}`);
    if (await file.exists()) {
      return new Response(file);
    }
    const htmlFile = Bun.file(`dist${path}.html`);
    if (await htmlFile.exists()) {
      return new Response(htmlFile);
    }
    return new Response(Bun.file("dist/index.html"));
  },
});
