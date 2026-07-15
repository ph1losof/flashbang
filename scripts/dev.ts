import { watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { normalize } from "node:path";
import { $ } from "bun";
import {
  handleOpenSearchRequest,
  handleSuggestRequest,
} from "../src/server/handlers";
import { pageHeaders, SW_HEADERS } from "../src/server/headers";
import { readPathname } from "../src/shared/raw-url";
import {
  assembleUIAssets,
  bundleUI,
  customSuggestUrlsEnabled,
  generateCSS,
} from "./shared";

const SECURITY_HEADERS = pageHeaders("'unsafe-inline'");

interface SSEClient {
  close: () => void;
  enqueue: (data: string) => void;
}
const clients = new Set<SSEClient>();

function broadcast() {
  const dead: SSEClient[] = [];
  for (const client of clients) {
    try {
      client.enqueue("data: reload\n\n");
    } catch {
      dead.push(client);
    }
  }
  for (const c of dead) {
    clients.delete(c);
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
  const allowUnsafeCustomSuggestUrls = customSuggestUrlsEnabled();
  console.log(
    `Custom suggestion URLs: ${allowUnsafeCustomSuggestUrls ? "enabled" : "disabled"}`
  );
  await mkdir("dist", { recursive: true });

  await Promise.all([
    Bun.build({
      entrypoints: ["src/sw/sw.ts"],
      outdir: "dist",
      naming: "sw.js",
      minify: true,
      target: "browser",
      format: "esm",
      define: {
        __CACHE_VERSION__: '"flashbang-dev"',
        __REQUIRED_APP_ASSETS__: "[]",
        __IS_DEV__: JSON.stringify(true),
      },
    }),
    bundleUI(allowUnsafeCustomSuggestUrls),
  ]);

  await generateCSS(true);
  await assembleUIAssets(allowUnsafeCustomSuggestUrls);

  console.log(`Build done in ${(performance.now() - t).toFixed(0)}ms`);
}

const generated = Bun.file("src/generated/bangs-min.js");
if (!(await generated.exists())) {
  console.warn("Generated bang data not found. Running codegen...");
  await $`bun run codegen`;
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
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...SECURITY_HEADERS,
      ...headers,
    },
  });
}

const port = Number(process.env.PORT) || 3000;
console.log(`Dev server: http://localhost:${port}`);

Bun.serve({
  port,
  idleTimeout: 255,
  async fetch(req) {
    const pathname = readPathname(req.url);

    if (pathname === "/__dev/events") {
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

    if (pathname === "/suggest") {
      const res = await handleSuggestRequest(req);
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
        res.headers.set(k, v);
      }
      return res;
    }

    if (pathname === "/opensearch.xml") {
      const res = handleOpenSearchRequest(req);
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
        res.headers.set(k, v);
      }
      return res;
    }

    if (pathname === "/sw.js") {
      return new Response(Bun.file("dist/sw.js"), { headers: SW_HEADERS });
    }

    if (pathname === "/bench") {
      const text = await Bun.file("dist/bench.html").text();
      return htmlResponse(text, {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "credentialless",
      });
    }

    const path = pathname === "/" ? "/index.html" : pathname;
    const normalized = normalize(`dist${path}`);
    if (!normalized.startsWith("dist/")) {
      return new Response("Not found", {
        status: 404,
        headers: SECURITY_HEADERS,
      });
    }
    const file = Bun.file(normalized);
    if (await file.exists()) {
      if (path.endsWith(".html")) {
        return htmlResponse(await file.text());
      }
      return new Response(file, { headers: SECURITY_HEADERS });
    }
    const htmlNormalized = normalize(`dist${path}.html`);
    if (htmlNormalized.startsWith("dist/")) {
      const htmlFile = Bun.file(htmlNormalized);
      if (await htmlFile.exists()) {
        return htmlResponse(await htmlFile.text());
      }
    }
    return htmlResponse(await Bun.file("dist/index.html").text());
  },
});
