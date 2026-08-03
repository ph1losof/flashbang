import { describe, expect, test } from "bun:test";
import {
  coldFallbackAssetFromHtml,
  pageHeaders,
  SW_CSP,
  SW_HEADERS,
  shellPreloadHeader,
} from "../src/server/headers";

describe("shell preload hint", () => {
  test("declares the cold resolver as a script preload", () => {
    expect(shellPreloadHeader("/cold-fallback-z2dzteq8.js")).toBe(
      "</cold-fallback-z2dzteq8.js>; rel=preload; as=script; crossorigin"
    );
  });

  test("keeps the credentials mode that import() actually uses", () => {
    // Without `crossorigin` the preload's credentials mode is "include" while
    // the module fetch uses "same-origin". Chrome then declines to reuse the
    // preload and downloads the module twice, which is strictly worse than
    // sending no hint at all.
    expect(shellPreloadHeader("/cold-fallback-z2dzteq8.js")).toMatch(
      /;\s*crossorigin$/
    );
  });

  test("recovers the content-addressed module from a built shell", () => {
    const html =
      "<script>(()=>{import(`/cold-fallback-z2dzteq8.js`).then(()=>{})})()</script>";
    expect(coldFallbackAssetFromHtml(html)).toBe("/cold-fallback-z2dzteq8.js");
  });

  test("prefers the cold module over the rich fallback", () => {
    // A fresh profile never loads the rich fallback, so it must not be hinted.
    const html =
      "import(`/fallback-damtt05n.js`);import(`/cold-fallback-z2dzteq8.js`)";
    expect(coldFallbackAssetFromHtml(html)).toBe("/cold-fallback-z2dzteq8.js");
  });

  test("reports no hint when the shell has no cold module", () => {
    expect(coldFallbackAssetFromHtml("<html></html>")).toBeNull();
  });
});

describe("server headers", () => {
  test("SW headers include strict CSP and security headers", () => {
    expect(SW_CSP).toContain("default-src 'self'");
    expect(SW_CSP).toContain("script-src 'self'");
    expect(SW_HEADERS["Content-Security-Policy"]).toBe(SW_CSP);
    expect(SW_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
    expect(SW_HEADERS["X-Frame-Options"]).toBe("DENY");
    expect(SW_HEADERS["Referrer-Policy"]).toBe(
      "strict-origin-when-cross-origin"
    );
    expect(SW_HEADERS["Strict-Transport-Security"]).toContain("max-age=");
    expect(SW_HEADERS["Permissions-Policy"]).toContain("camera=()");
  });

  test("page headers compose caller script-src with core directives", () => {
    const headers = pageHeaders("'unsafe-inline'");
    const csp = headers["Content-Security-Policy"];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["X-Frame-Options"]).toBe("DENY");
  });

  test("page headers support hash-only inline script policy", () => {
    const csp = pageHeaders("'sha256-example'")["Content-Security-Policy"];
    expect(csp).toContain("script-src 'self' 'sha256-example'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  });
});
