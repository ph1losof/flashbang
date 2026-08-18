interface Bang {
  domain: string;
  name: string;
  trigger: string;
  [field: string]: unknown;
}

const DETAIL_LIMIT = 50;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function code(value: unknown): string {
  let text: string;
  if (value === undefined) {
    text = "not set";
  } else if (typeof value === "string") {
    text = value;
  } else {
    text = JSON.stringify(value) ?? String(value);
  }
  return `<code>${escapeHtml(text)}</code>`;
}

function bangLabel(bang: Bang): string {
  return `${code(`!${bang.trigger}`)} ${escapeHtml(bang.name)} (${code(bang.domain)})`;
}

function renderSection(title: string, items: readonly string[]): string {
  const visible = items.slice(0, DETAIL_LIMIT);
  const lines = [`### ${title} (${items.length})`];
  if (visible.length === 0) {
    lines.push("None.");
  } else {
    lines.push(...visible.map((item) => `- ${item}`));
  }
  if (items.length > DETAIL_LIMIT) {
    lines.push(`- ${items.length - DETAIL_LIMIT} more not shown`);
  }
  return lines.join("\n");
}

function compareValues(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function summarizeBangUpdate(
  previous: readonly Bang[],
  current: readonly Bang[]
): string {
  const previousByTrigger = new Map(
    previous.map((bang) => [bang.trigger, bang])
  );
  const currentByTrigger = new Map(current.map((bang) => [bang.trigger, bang]));

  const added = current
    .filter((bang) => !previousByTrigger.has(bang.trigger))
    .map(bangLabel);
  const removed = previous
    .filter((bang) => !currentByTrigger.has(bang.trigger))
    .map(bangLabel);
  const updated = current.flatMap((bang) => {
    const oldBang = previousByTrigger.get(bang.trigger);
    if (!oldBang) {
      return [];
    }
    const fields = [...new Set([...Object.keys(oldBang), ...Object.keys(bang)])]
      .filter(
        (field) =>
          field !== "trigger" && !compareValues(oldBang[field], bang[field])
      )
      .sort();
    if (fields.length === 0) {
      return [];
    }
    const changes = fields.map(
      (field) =>
        `${code(field)} changed from ${code(oldBang[field])} to ${code(bang[field])}`
    );
    return [`${bangLabel(bang)}: ${changes.join("; ")}`];
  });

  const totalDelta = current.length - previous.length;
  const signedDelta = totalDelta > 0 ? `+${totalDelta}` : String(totalDelta);
  return [
    "Automated daily update of the merged DuckDuckGo and Kagi bang data.",
    "",
    "## Summary",
    "",
    `- Total bangs: ${previous.length} to ${current.length} (${signedDelta})`,
    `- Added: ${added.length}`,
    `- Removed: ${removed.length}`,
    `- Updated: ${updated.length}`,
    "",
    "## Changes",
    "",
    renderSection("Added", added),
    "",
    renderSection("Removed", removed),
    "",
    renderSection("Updated", updated),
    "",
    "## How",
    "",
    "The workflow fetches DuckDuckGo and Kagi, applies Flashbang's custom bangs and the canonical-destination overlay, merges entries by trigger, and validates the generated data. Auto-merge is enabled only after the required checks pass.",
    "",
  ].join("\n");
}

if (import.meta.main) {
  const [previousPath, currentPath] = process.argv.slice(2);
  if (!(previousPath && currentPath)) {
    console.error(
      "Usage: bun scripts/summarize-bang-update.ts <previous.json> <current.json>"
    );
    process.exit(1);
  }
  const [previous, current] = await Promise.all([
    Bun.file(previousPath).json() as Promise<Bang[]>,
    Bun.file(currentPath).json() as Promise<Bang[]>,
  ]);
  process.stdout.write(summarizeBangUpdate(previous, current));
}
