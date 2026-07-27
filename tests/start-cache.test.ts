import { describe, expect, test } from "bun:test";
import { extractInlineScriptHashes } from "../scripts/inline-script-hash";
import {
  acceptsBrotli,
  cacheControlForAsset,
  staticAssetHeaders,
} from "../scripts/start";

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
