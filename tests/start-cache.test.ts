import { describe, expect, test } from "bun:test";
import {
  acceptsBrotli,
  cacheControlForAsset,
  extractInlineScriptHashes,
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
    expect(cacheControlForAsset("/index.html")).toBe("no-cache");
    expect(cacheControlForAsset("/sw.js")).toBe("no-cache");
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
