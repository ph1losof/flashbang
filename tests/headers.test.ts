import { describe, expect, test } from "bun:test";
import {
  controlledPageHeaders,
  pageHeaders,
  SW_CSP,
  SW_HEADERS,
} from "../src/server/headers";

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

  test("controlled page headers omit unrelated CSP directives", () => {
    const csp =
      controlledPageHeaders("'sha256-example'")["Content-Security-Policy"];
    expect(csp).toContain("script-src 'self' 'sha256-example'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("worker-src");
    expect(csp).not.toContain("manifest-src");
  });
});
