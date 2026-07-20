import {
  type CaptureUrlParts,
  type CustomBangRecord,
  compileCaptureUrl,
} from "../shared/capture-template";
import {
  DEFAULT_LUCKY_URL,
  DEFAULT_URL,
  FRECENCY_HALF_LIFE_MS,
  LUCKY_TRIGGER_PROVIDERS,
  LUCKY_URLS,
  MAX_FRECENCY_ENTRIES,
} from "../shared/constants";
import {
  parseFrecencyCompact,
  serializeFrecencyCompact,
} from "../shared/frecency-serial";
import { hashFNV1a } from "../shared/hash";
import { idbWrap, openDB, resetDB } from "../shared/idb";
import { compileSnapTarget, type SnapTargetParts } from "../shared/snap-target";
import { resolveTriggerPrefixes } from "../shared/trigger-prefix";
import { lookupBang } from "./bang-data";
import {
  buildTopFrecency,
  type TopFrecencyEntry,
  updateTopFrecencyOnIncrement,
} from "./frecency";
import {
  type CustomUrlParts,
  compileTriggerSyntax,
  type RedirectSettings,
  type UrlParts,
} from "./redirect";

function splitUrl(url: string): UrlParts {
  const idx = url.indexOf("{}");
  return idx === -1
    ? [url, null]
    : [url.substring(0, idx), url.substring(idx + 2)];
}

function attachSnapTarget(
  entry: UrlParts | CaptureUrlParts,
  snap: SnapTargetParts | null
): CustomUrlParts {
  return snap ? ([...entry, snap] as CustomUrlParts) : entry;
}

const FRECENCY_COOKIE_ENTRIES = 8;

interface FrecencySnapshot {
  counts: Record<string, number> | null;
  ts: number;
}

let persistPromise: Promise<void> | null = null;
let persistPending: FrecencySnapshot | null = null;
let cachedRedirect: RedirectSettings | null = null;
let redirectSettingsPromise: Promise<RedirectSettings> | null = null;
let redirectSettingsRetryAt = 0;
let frecencyCounts: Record<string, number> | null = null;
let frecencyLoaded = false;
let loadFrecencyPromise: Promise<void> | null = null;
let topFrecency: TopFrecencyEntry[] = [];
let lastDecayTs: number = 0;

function emptyFrecencyCounts(): Record<string, number> {
  return Object.create(null) as Record<string, number>;
}

export function getCachedSettings(): RedirectSettings | null {
  if (redirectSettingsRetryAt !== 0 && Date.now() >= redirectSettingsRetryAt) {
    cachedRedirect = null;
    redirectSettingsRetryAt = 0;
    resetDB();
  }
  return cachedRedirect;
}

export function seedRedirectSettings(settings: RedirectSettings): void {
  cachedRedirect = settings;
  redirectSettingsRetryAt = 0;
}

export function readRedirectSettings(): Promise<RedirectSettings> {
  const cached = getCachedSettings();
  if (cached) {
    return Promise.resolve(cached);
  }

  if (!redirectSettingsPromise) {
    redirectSettingsPromise = (async () => {
      try {
        const db = await openDB();
        const tx = db.transaction(["settings", "custom-bangs"], "readonly");
        const [settings, all] = await Promise.all([
          idbWrap<Array<{ key: string; value?: string }>>(
            tx.objectStore("settings").getAll()
          ),
          idbWrap<CustomBangRecord[]>(tx.objectStore("custom-bangs").getAll()),
        ]);
        const settingsMap = Object.fromEntries(
          settings.map((s) => [s.key, s.value])
        );
        hydrateFrecency(settingsMap.frecency);
        const defaultBang = settingsMap["default-bang"] || "g";
        const custom: Record<string, CustomUrlParts> = Object.create(null);
        for (const e of all) {
          const snap = e.snap ? compileSnapTarget(e.snap) : null;
          if (e.regex) {
            const advanced = compileCaptureUrl(e.url, e.regex, e.encoding);
            if (advanced) {
              custom[e.trigger] = attachSnapTarget(advanced, snap);
            }
          } else {
            custom[e.trigger] = attachSnapTarget(splitUrl(e.url), snap);
          }
        }

        const customDefault = custom[defaultBang];
        let defaultEntry: UrlParts | null;
        if (customDefault) {
          defaultEntry =
            customDefault.length < 5 ? (customDefault as UrlParts) : null;
        } else {
          defaultEntry = lookupBang(defaultBang, hashFNV1a(defaultBang));
        }
        const defaultUrl = defaultEntry || splitUrl(DEFAULT_URL);
        const effectiveDefaultBang = defaultEntry ? defaultBang : "g";
        const [bangPrefix, snapPrefix] = resolveTriggerPrefixes(
          settingsMap["bang-prefix"],
          settingsMap["snap-prefix"]
        );

        const luckyProvider = settingsMap["lucky-provider"] ?? "default";
        let luckyUrl: UrlParts | null;
        switch (luckyProvider) {
          case "none":
            luckyUrl = null;
            break;
          case "google":
            luckyUrl = splitUrl(LUCKY_URLS.google);
            break;
          case "ddg":
            luckyUrl = splitUrl(LUCKY_URLS.ddg);
            break;
          case "kagi":
            luckyUrl = splitUrl(LUCKY_URLS.kagi);
            break;
          case "custom":
            luckyUrl = settingsMap["lucky-url"]
              ? splitUrl(settingsMap["lucky-url"])
              : null;
            break;
          default:
            luckyUrl = splitUrl(
              LUCKY_URLS[LUCKY_TRIGGER_PROVIDERS[effectiveDefaultBang]] ||
                DEFAULT_LUCKY_URL
            );
            break;
        }

        const syntax = compileTriggerSyntax(bangPrefix, snapPrefix);
        cachedRedirect = {
          defaultUrl,
          custom,
          luckyUrl,
          ...(syntax ? { syntax } : {}),
        };
        redirectSettingsRetryAt = 0;
      } catch {
        await loadFrecency();
        cachedRedirect = {
          defaultUrl: splitUrl(DEFAULT_URL),
          custom: Object.create(null),
          luckyUrl: splitUrl(DEFAULT_LUCKY_URL),
        };
        redirectSettingsRetryAt = Date.now() + 5_000;
        resetDB();
      }

      return cachedRedirect as RedirectSettings;
    })().finally(() => {
      redirectSettingsPromise = null;
    });
  }

  return redirectSettingsPromise;
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB write aborted"));
  });
}

async function drainFrecencyPersistence(): Promise<void> {
  while (persistPending) {
    const snapshot = persistPending;
    persistPending = null;
    const value = `${snapshot.ts}|${serializeFrecencyCompact(snapshot.counts)}`;
    try {
      const db = await openDB();
      const tx = db.transaction("settings", "readwrite");
      const done = transactionDone(tx);
      tx.objectStore("settings").put({ key: "frecency", value });
      await done;
      if (!frecencyLoaded) {
        frecencyLoaded = true;
      }
    } catch {
      persistPending = null;
      resetDB();
      return;
    }
  }
}

function persistFrecencySnapshot(
  counts: Record<string, number> | null,
  ts: number
): Promise<void> {
  persistPending = { counts, ts };
  if (!persistPromise) {
    const draining = drainFrecencyPersistence();
    let current: Promise<void>;
    current = draining.finally(() => {
      if (persistPromise === current) {
        persistPromise = null;
      }
    });
    persistPromise = current;
  }
  return persistPromise;
}

export function invalidateCache() {
  cachedRedirect = null;
  redirectSettingsPromise = null;
  resetDB();
}

function applyDecay(): boolean {
  if (!(frecencyCounts && lastDecayTs)) {
    lastDecayTs = Date.now();
    return false;
  }
  const now = Date.now();
  const elapsed = now - lastDecayTs;
  if (elapsed < 3_600_000) {
    return false;
  }
  const factor = 0.5 ** (elapsed / FRECENCY_HALF_LIFE_MS);
  const pruned = emptyFrecencyCounts();
  for (const key of Object.keys(frecencyCounts)) {
    const decayed = Math.round(frecencyCounts[key] * factor);
    if (decayed >= 1) {
      pruned[key] = decayed;
    }
  }
  frecencyCounts = pruned;
  lastDecayTs = now;
  return true;
}

function pruneFrecency(): boolean {
  if (!frecencyCounts) {
    return false;
  }
  const keys = Object.keys(frecencyCounts);
  if (keys.length <= MAX_FRECENCY_ENTRIES) {
    return false;
  }
  const entries = Object.entries(frecencyCounts);
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const pruned = emptyFrecencyCounts();
  for (const [trigger, count] of entries.slice(0, MAX_FRECENCY_ENTRIES)) {
    pruned[trigger] = count;
  }
  frecencyCounts = pruned;
  return true;
}

function hydrateFrecency(stored: string | undefined): void {
  if (frecencyLoaded) {
    return;
  }
  let loaded = emptyFrecencyCounts();
  let shouldPersist = false;
  if (stored) {
    const pipeIdx = stored.indexOf("|");
    lastDecayTs =
      pipeIdx > 0
        ? parseInt(stored.substring(0, pipeIdx), 10) || Date.now()
        : Date.now();
    if (pipeIdx === -1) {
      shouldPersist = true;
    } else {
      loaded = parseFrecencyCompact(stored.substring(pipeIdx + 1));
    }
  } else {
    lastDecayTs = Date.now();
  }

  if (frecencyCounts) {
    for (const trigger of Object.keys(frecencyCounts)) {
      loaded[trigger] = (loaded[trigger] || 0) + frecencyCounts[trigger];
    }
  }
  frecencyCounts = loaded;
  frecencyLoaded = true;
  shouldPersist = applyDecay() || pruneFrecency() || shouldPersist;
  topFrecency = buildTopFrecency(frecencyCounts, FRECENCY_COOKIE_ENTRIES);
  if (shouldPersist) {
    void persistFrecencySnapshot(frecencyCounts, lastDecayTs);
  }
}

export function hasTopFrecency(): boolean {
  return topFrecency.length > 0;
}

export function getTopFrecencyRecord(): Record<string, number> {
  const out: Record<string, number> = Object.create(null);
  for (const e of topFrecency) {
    out[e.trigger] = e.count;
  }
  return out;
}

export function loadFrecency(): Promise<void> {
  if (frecencyLoaded) {
    return Promise.resolve();
  }

  if (!loadFrecencyPromise) {
    loadFrecencyPromise = (async () => {
      try {
        const db = await openDB();
        const tx = db.transaction("settings", "readonly");
        const store = tx.objectStore("settings");
        const result = await idbWrap<{ value?: string } | undefined>(
          store.get("frecency")
        );
        hydrateFrecency(result?.value);
      } catch {
        resetDB();
      }
    })().finally(() => {
      loadFrecencyPromise = null;
    });
  }

  return loadFrecencyPromise;
}

export function trackBangUsage(trigger: string): {
  persistence: Promise<void>;
  topChanged: boolean;
} {
  if (!frecencyCounts) {
    frecencyCounts = emptyFrecencyCounts();
    topFrecency = [];
  }
  if (!lastDecayTs) {
    lastDecayTs = Date.now();
  }
  const nextCount = (frecencyCounts[trigger] || 0) + 1;
  frecencyCounts[trigger] = nextCount;
  updateTopFrecencyOnIncrement(
    topFrecency,
    trigger,
    nextCount,
    FRECENCY_COOKIE_ENTRIES
  );
  pruneFrecency();
  return {
    persistence: persistFrecencySnapshot(frecencyCounts, lastDecayTs),
    topChanged: topFrecency.some((entry) => entry.trigger === trigger),
  };
}
