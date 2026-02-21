import { watch } from "node:fs";
import { minify } from "@minify-html/node";
import { $ } from "bun";
import { parseCookie } from "../src/suggest";

interface SSEClient {
  close: () => void;
  enqueue: (data: string) => void;
}
const clients = new Set<SSEClient>();

function broadcast() {
  for (const client of clients) {
    try {
      client.enqueue("data: reload\n\n");
    } catch {
      clients.delete(client);
    }
  }
}

const LIVE_RELOAD_SCRIPT = `<script>
const __es = new EventSource("/__dev/events");
__es.onmessage = async () => {
  __es.close();
  const regs = await navigator.serviceWorker.getRegistrations();
  await Promise.all(regs.map(r => r.unregister()));
  const keys = await caches.keys();
  await Promise.all(keys.map(k => caches.delete(k)));
  location.reload();
};
addEventListener("beforeunload", () => __es.close());
</script>`;

async function build() {
  const t = performance.now();
  await $`mkdir -p dist`;

  await Promise.all([
    Bun.build({
      entrypoints: ["src/sw/sw.ts"],
      outdir: "dist",
      naming: "sw.js",
      minify: true,
      target: "browser",
      format: "esm",
    }),
    Bun.build({
      entrypoints: ["src/ui/app.ts"],
      outdir: "dist",
      naming: "app.js",
      splitting: true,
      minify: true,
      target: "browser",
      format: "esm",
    }),
    Bun.build({
      entrypoints: ["src/ui/bench.ts"],
      outdir: "dist",
      naming: "bench.js",
      minify: true,
      target: "browser",
      format: "esm",
    }),
  ]);

  await $`bunx unocss "src/ui/home.html" "src/ui/bench.html" "src/ui/app.ts" "src/ui/bench.ts" "src/ui/liquid-metal.ts" -o dist/styles.css --minify`.quiet();

  const css = await Bun.file("dist/styles.css").text();
  const inlineCSS = (src: string) =>
    src.replace(
      '<link rel="stylesheet" href="/styles.css" />',
      `<style>${css}</style>`
    );

  const indexHtml = await Bun.file("src/ui/index.html").text();
  await Bun.write(
    "dist/index.html",
    minify(Buffer.from(indexHtml), { minify_css: true, minify_js: true })
  );

  const homeHtml = await Bun.file("src/ui/home.html").text();
  await Bun.write(
    "dist/home.html",
    minify(Buffer.from(inlineCSS(homeHtml)), {
      minify_css: true,
      minify_js: true,
    })
  );

  const benchHtml = await Bun.file("src/ui/bench.html").text();
  await Bun.write(
    "dist/bench.html",
    minify(Buffer.from(inlineCSS(benchHtml)), {
      minify_css: true,
      minify_js: true,
    })
  );

  await Bun.write("dist/robots.txt", "User-agent: *\nAllow: /\n");

  console.log(`Build done in ${(performance.now() - t).toFixed(0)}ms`);
}

await build();

let timeout: Timer;
watch("src", { recursive: true }, (_event, filename) => {
  if (
    filename &&
    (filename.endsWith(".test.ts") || filename.endsWith(".test.js"))
  ) {
    return;
  }
  clearTimeout(timeout);
  timeout = setTimeout(async () => {
    console.log("File change detected, rebuilding...");
    try {
      await build();
      broadcast();
    } catch (e) {
      console.error("Build failed:", e);
    }
  }, 200);
});

function injectLiveReload(html: string): string {
  const idx = html.lastIndexOf("</body>");
  if (idx !== -1) {
    return html.slice(0, idx) + LIVE_RELOAD_SCRIPT + html.slice(idx);
  }
  return html + LIVE_RELOAD_SCRIPT;
}

function htmlResponse(
  file: string,
  headers?: Record<string, string>
): Response {
  const content = injectLiveReload(file);
  return new Response(content, {
    headers: { "Content-Type": "text/html; charset=utf-8", ...headers },
  });
}

const port = Number(process.env.PORT) || 3000;
console.log(`Dev server: http://localhost:${port}`);

Bun.serve({
  port,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/__dev/events") {
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          const client: SSEClient = {
            enqueue: (data: string) => controller.enqueue(encoder.encode(data)),
            close: () => controller.close(),
          };
          clients.add(client);
          client.enqueue(": connected\n\n");
          req.signal.addEventListener("abort", () => {
            clients.delete(client);
          });
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    if (url.pathname === "/suggest" && url.searchParams.get("q")) {
      const { suggest } = await import("../src/suggest");
      return suggest(url.searchParams.get("q")!, parseCookie(req));
    }

    if (url.pathname === "/opensearch.xml") {
      const { opensearch } = await import("../src/opensearch");
      return opensearch(url.origin);
    }

    if (url.pathname === "/bench") {
      const text = await Bun.file("dist/bench.html").text();
      return htmlResponse(text, {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "credentialless",
      });
    }

    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(`dist${path}`);
    if (await file.exists()) {
      if (path.endsWith(".html")) {
        return htmlResponse(await file.text());
      }
      return new Response(file);
    }
    const htmlFile = Bun.file(`dist${path}.html`);
    if (await htmlFile.exists()) {
      return htmlResponse(await htmlFile.text());
    }
    return htmlResponse(await Bun.file("dist/index.html").text());
  },
});
