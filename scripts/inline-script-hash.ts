import { createHash } from "node:crypto";

export function extractInlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  const scriptPattern = /<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/gi;
  for (const match of html.matchAll(scriptPattern)) {
    if (match[1]) {
      hashes.push(
        `'sha256-${createHash("sha256").update(match[1]).digest("base64")}'`
      );
    }
  }
  return hashes;
}
