export interface BangMeta {
  capture: boolean;
  domain: string;
  domainLower: string;
  name: string;
  nameLower: string;
  trigger: string;
}

export interface BangCatalog {
  byTrigger: ReadonlyMap<string, BangMeta>;
  entries: readonly BangMeta[];
}

interface ScoredBang {
  entry: BangMeta;
  score: number;
}

let catalogPromise: Promise<BangCatalog> | null = null;

export function createBangMeta(
  trigger: string,
  name: string,
  domain: string,
  capture = false
): BangMeta {
  return {
    capture,
    domain,
    domainLower: domain.toLowerCase(),
    name,
    nameLower: name.toLowerCase(),
    trigger,
  };
}

export function loadBuiltinBangCatalog(): Promise<BangCatalog> {
  if (!catalogPromise) {
    catalogPromise = import("../generated/bangs-meta.js").then((module) => {
      const generated = module.BANGS;
      const captureIndexes = module.CAPTURE_INDEXES;
      const entries = new Array<BangMeta>(generated.length / 3);
      const byTrigger = new Map<string, BangMeta>();
      let captureOffset = 0;
      for (
        let i = 0, entryIndex = 0;
        i < generated.length;
        i += 3, entryIndex++
      ) {
        const capture = captureIndexes[captureOffset] === entryIndex;
        if (capture) {
          captureOffset++;
        }
        const entry = createBangMeta(
          generated[i],
          generated[i + 1],
          generated[i + 2],
          capture
        );
        entries[entryIndex] = entry;
        byTrigger.set(entry.trigger, entry);
      }
      return {
        byTrigger,
        entries,
      };
    });
  }
  return catalogPromise;
}

function scoreBang(entry: BangMeta, query: string): number {
  if (entry.trigger === query) {
    return 0;
  }
  if (entry.trigger.startsWith(query)) {
    return 1;
  }
  if (entry.nameLower.startsWith(query)) {
    return 2;
  }
  if (entry.domainLower.startsWith(query)) {
    return 3;
  }
  if (entry.trigger.includes(query)) {
    return 4;
  }
  if (entry.nameLower.includes(query)) {
    return 5;
  }
  return entry.domainLower.includes(query) ? 6 : -1;
}

export function searchBangs(
  entries: readonly BangMeta[],
  rawQuery: string,
  limit: number
): BangMeta[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query || limit <= 0) {
    return [];
  }

  const best: ScoredBang[] = [];
  for (const entry of entries) {
    const score = scoreBang(entry, query);
    if (score < 0) {
      continue;
    }

    let position = 0;
    while (position < best.length) {
      const current = best[position];
      const triggerOrder =
        entry.trigger < current.entry.trigger
          ? -1
          : Number(entry.trigger > current.entry.trigger);
      const order =
        score - current.score ||
        entry.trigger.length - current.entry.trigger.length ||
        triggerOrder;
      if (order < 0) {
        break;
      }
      position++;
    }

    if (position < limit) {
      best.splice(position, 0, { entry, score });
      if (best.length > limit) {
        best.pop();
      }
    }
  }

  return best.map((item) => item.entry);
}
