export function serializeFrecencyCompact(
  counts: Record<string, number> | null
): string {
  if (!counts) {
    return "";
  }
  const parts: string[] = [];
  for (const key of Object.keys(counts)) {
    parts.push(`${key}:${counts[key]}`);
  }
  return parts.join(",");
}

export function parseFrecencyCompact(raw: string): Record<string, number> {
  const out: Record<string, number> = Object.create(null);
  if (!raw) {
    return out;
  }
  let start = 0;
  while (start < raw.length) {
    const comma = raw.indexOf(",", start);
    const end = comma === -1 ? raw.length : comma;
    const colon = raw.indexOf(":", start);
    if (colon !== -1 && colon < end) {
      const count = parseInt(raw.substring(colon + 1, end), 10);
      if (count > 0) {
        out[raw.substring(start, colon)] = count;
      }
    }
    start = end + 1;
  }
  return out;
}
