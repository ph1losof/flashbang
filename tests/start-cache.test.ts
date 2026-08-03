import { describe, expect, test } from "bun:test";
import { extractInlineScriptHashes } from "../scripts/inline-script-hash";
import {
  acceptsBrotli,
  buildStaticManifest,
  cacheControlForAsset,
  createStaticFetchHandler,
  type StaticAsset,
  serveCompressed,
  staticAssetHeaders,
} from "../scripts/start";

const staticAsset = (text: string, type: string): StaticAsset => ({
  file: new Blob([text]) as unknown as Bun.BunFile,
  br: null,
  type,
});

const compressedStaticAsset = (
  text: string,
  compressed: string,
  type: string
): StaticAsset => ({
  file: new Response(text).body! as unknown as Bun.BunFile,
  br: new Response(compressed).body! as unknown as Bun.BunFile,
  type,
});

describe("production static caching", () => {
  test("negotiates Brotli using encoding q-values", () => {
    expect(acceptsBrotli("gzip, br")).toBe(true);
    expect(acceptsBrotli("gzip, br;q=0")).toBe(false);
    expect(acceptsBrotli("gzip, br;q=0.25")).toBe(true);
    expect(acceptsBrotli("gzip, *;q=0.5")).toBe(true);
    expect(acceptsBrotli("gzip, *;q=0.5, br;q=0")).toBe(false);
    expect(acceptsBrotli("xbr, gzip")).toBe(false);
  });

  test("ignores absent, invalid, and disabled Brotli negotiation", () => {
    expect(acceptsBrotli(null)).toBe(false);
    expect(acceptsBrotli("br;q=bogus")).toBe(false);
    expect(acceptsBrotli("br;q=2, *;q=0")).toBe(false);
    expect(acceptsBrotli("gzip;q=0.5, *;q=0.25")).toBe(true);
  });
  test("only content-hashed assets are immutable", () => {
    expect(cacheControlForAsset("/chunk-abc12345.js")).toBe(
      "public, max-age=31536000, immutable"
    );
    expect(cacheControlForAsset("/bangs-0123456789ab.bin")).toBe(
      "public, max-age=31536000, immutable"
    );
    expect(cacheControlForAsset("/bangs-meta-0123456789ab.bin")).toBe(
      "public, max-age=31536000, immutable"
    );
    expect(cacheControlForAsset("/fallback-0123456789ab.js")).toBe(
      "public, max-age=31536000, immutable"
    );
    expect(cacheControlForAsset("/cold-fallback-0123456789ab.js")).toBe(
      "public, max-age=31536000, immutable"
    );
    // Shards carry a base36 id between the prefix and the version hash, so both
    // the single- and double-digit forms have to match.
    expect(cacheControlForAsset("/bangs-str-0123456789ab.bin")).toBe(
      "public, max-age=31536000, immutable"
    );
    for (const shard of ["s0", "s9", "sw", "s10", "s16", "i0", "iw", "i13"]) {
      expect(cacheControlForAsset(`/bangs-${shard}-0123456789ab.bin`)).toBe(
        "public, max-age=31536000, immutable"
      );
    }
    for (const path of [
      "/app.js",
      "/bench.js",
      "/icon.svg",
      "/manifest.json",
      "/robots.txt",
    ]) {
      expect(cacheControlForAsset(path)).toBe(
        "public, max-age=0, must-revalidate"
      );
    }
    expect(cacheControlForAsset("/index.html")).toBe("public, max-age=300");
    expect(cacheControlForAsset("/home.html")).toBe("no-cache");
    expect(cacheControlForAsset("/bench.html")).toBe("no-cache");
    expect(cacheControlForAsset("/sw.js")).toBe("no-cache");
  });

  test("makes only the fallback shell query-blind", () => {
    const fallback = staticAssetHeaders("/index.html", "text/html", false);
    const home = staticAssetHeaders("/home.html", "text/html", false);

    expect(fallback["No-Vary-Search"]).toBe('params=("q")');
    expect(fallback["Cache-Control"]).toBe("public, max-age=300");
    expect(home["No-Vary-Search"]).toBeUndefined();
    expect(home["Cache-Control"]).toBe("no-cache");
  });

  test("compressed and identity responses share representation headers", () => {
    const identity = staticAssetHeaders("/app.js", "text/javascript", false);
    const compressed = staticAssetHeaders("/app.js", "text/javascript", true);

    expect(identity["Content-Type"]).toBe("text/javascript");
    expect(compressed["Content-Type"]).toBe(identity["Content-Type"]);
    expect(compressed["Cache-Control"]).toBe(identity["Cache-Control"]);
    expect(identity.Vary).toBe("Accept-Encoding");
    expect(compressed.Vary).toBe("Accept-Encoding");
    expect(identity["Content-Encoding"]).toBeUndefined();
    expect(compressed["Content-Encoding"]).toBe("br");
    expect(identity["Content-Security-Policy"]).not.toContain(
      "script-src 'self' 'unsafe-inline'"
    );
  });

  test("serves identity and Brotli static assets from a manifest", async () => {
    const manifest = new Map([
      [
        "/app.js",
        compressedStaticAsset("identity", "compressed", "text/javascript"),
      ],
    ]);

    const identity = serveCompressed(
      manifest,
      new Request("https://example.com/app.js"),
      "/app.js"
    );
    expect(identity).not.toBeNull();
    expect(await identity!.text()).toBe("identity");
    expect(identity!.headers.get("Content-Encoding")).toBeNull();

    const compressed = serveCompressed(
      manifest,
      new Request("https://example.com/app.js", {
        headers: { "Accept-Encoding": "gzip, br" },
      }),
      "/app.js",
      { "X-Test": "1" }
    );
    expect(compressed).not.toBeNull();
    expect(await compressed!.text()).toBe("compressed");
    expect(compressed!.headers.get("Content-Encoding")).toBe("br");
    expect(compressed!.headers.get("X-Test")).toBe("1");
    expect(
      serveCompressed(
        manifest,
        new Request("https://example.com/missing"),
        "/missing"
      )
    ).toBeNull();
  });

  test("discovers static manifest entries and their compressed siblings", async () => {
    await Bun.write("dist/start-cache-test.txt", "hello");
    await Bun.write("dist/start-cache-test.txt.br", "br");
    try {
      const manifest = buildStaticManifest();
      const asset = manifest.get("/start-cache-test.txt");
      expect(asset).toBeDefined();
      expect(asset!.br).not.toBeNull();
      expect(manifest.has("/start-cache-test.txt.br")).toBe(false);
    } finally {
      await Bun.file("dist/start-cache-test.txt").delete();
      await Bun.file("dist/start-cache-test.txt.br").delete();
    }
  });
  test("routes production requests through the static fetch handler", async () => {
    const manifest = new Map([
      ["/index.html", staticAsset("index", "text/html")],
      ["/bench.html", staticAsset("bench", "text/html")],
      ["/app.js", staticAsset("app", "text/javascript")],
      ["/sw.js", staticAsset("sw", "text/javascript")],
      ["/docs.html", staticAsset("docs", "text/html")],
    ]);
    const fetch = createStaticFetchHandler(manifest, [["X-Security", "1"]]);

    await expect(
      fetch(new Request("https://example.com/health")).then((r) => r.text())
    ).resolves.toBe("ok");
    await expect(
      fetch(new Request("https://example.com/")).then((r) => r.text())
    ).resolves.toBe("index");
    await expect(
      fetch(new Request("https://example.com/bench")).then((r) => r.text())
    ).resolves.toBe("bench");
    await expect(
      fetch(new Request("https://example.com/app.js")).then((r) => r.text())
    ).resolves.toBe("app");
    await expect(
      fetch(new Request("https://example.com/docs")).then((r) => r.text())
    ).resolves.toBe("docs");
    await expect(
      fetch(new Request("https://example.com/missing")).then((r) => r.text())
    ).resolves.toBe("index");

    const sw = await fetch(new Request("https://example.com/sw.js"));
    expect(await sw.text()).toBe("sw");
    expect(sw.headers.get("Content-Security-Policy")).toContain(
      "connect-src 'self'"
    );
  });
  test("hashes only inline scripts for the production CSP", () => {
    const hashes = extractInlineScriptHashes(
      '<script>inline()</script><SCRIPT nonce="test">upper()</SCRIPT>' +
        '<script type="module" src="/app.js"></script>'
    );
    expect(hashes).toHaveLength(2);
    for (const hash of hashes) {
      expect(hash).toMatch(/^'sha256-[A-Za-z0-9+/]+=*'$/);
    }
  });
});
