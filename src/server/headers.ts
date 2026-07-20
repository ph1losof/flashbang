const BASE_HEADERS: Record<string, string> = {
  "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

// SW runtime avoids eval; keep CSP strict.
export const SW_CSP =
  "default-src 'self'; script-src 'self'; connect-src 'self'";

export const SW_HEADERS: Record<string, string> = {
  "Content-Security-Policy": SW_CSP,
  ...BASE_HEADERS,
};

export function pageHeaders(scriptSrc: string): Record<string, string> {
  return {
    "Content-Security-Policy": [
      "default-src 'self'",
      `script-src 'self'${scriptSrc ? ` ${scriptSrc}` : ""}`,
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "worker-src 'self'",
      "manifest-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
    ...BASE_HEADERS,
  };
}

export function controlledPageHeaders(
  scriptSrc: string
): Record<string, string> {
  return {
    "Content-Security-Policy": [
      "default-src 'self'",
      `script-src 'self'${scriptSrc ? ` ${scriptSrc}` : ""}`,
      "style-src 'unsafe-inline'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ].join("; "),
    ...BASE_HEADERS,
  };
}
