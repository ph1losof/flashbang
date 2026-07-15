import { lookupBang } from "../generated/bangs-min.js";
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
import {
  buildTopFrecency,
  type TopFrecencyEntry,
  updateTopFrecencyOnIncrement,
} from "./frecency";
import type { CustomUrlParts, RedirectSettings, UrlParts } from "./redirect";

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

let persistInFlight = false;
let persistPending: {
  counts: Record<string, number> | null;
  ts: number;
} | null = null;
let cachedRedirect: RedirectSettings | null = null;
let redirectSettingsPromise: Promise<RedirectSettings> | null = null;
let frecencyCounts: Record<string, number> | null = null;
let loadFrecencyPromise: Promise<void> | null = null;
let topFrecency: TopFrecencyEntry[] = [];
let lastDecayTs: number = 0;

function emptyFrecencyCounts(): Record<string, number> {
  return Object.create(null) as Record<string, number>;
}

export function getCachedSettings(): RedirectSettings | null {
  return cachedRedirect;
}

export function readRedirectSettings(): Promise<RedirectSettings> {
  if (cachedRedirect) {
    return Promise.resolve(cachedRedirect);
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
        const defaultBang = settingsMap["default-bang"] || "g";
        const tpl = lookupBang(defaultBang, hashFNV1a(defaultBang));
        const defaultUrl: UrlParts = tpl || splitUrl(DEFAULT_URL);
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
              LUCKY_URLS[LUCKY_TRIGGER_PROVIDERS[defaultBang]] ||
                DEFAULT_LUCKY_URL
            );
            break;
        }

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

        cachedRedirect = { defaultUrl, custom, luckyUrl };
      } catch {
        cachedRedirect = {
          defaultUrl: splitUrl(DEFAULT_URL),
          custom: Object.create(null),
          luckyUrl: splitUrl(DEFAULT_LUCKY_URL),
        };
      }

      return cachedRedirect as RedirectSettings;
    })().finally(() => {
      redirectSettingsPromise = null;
    });
  }

  return redirectSettingsPromise;
}

function persistFrecencySnapshot(
  counts: Record<string, number> | null,
  ts: number
): void {
  if (persistInFlight) {
    persistPending = { counts, ts };
    return;
  }
  persistInFlight = true;
  persistPending = null;
  const value = `${ts}|${serializeFrecencyCompact(counts)}`;
  openDB()
    .then((db) => {
      const tx = db.transaction("settings", "readwrite");
      tx.objectStore("settings").put({ key: "frecency", value });
    })
    .catch(() => {
      /* best-effort write; ignore failure */
    })
    .finally(() => {
      persistInFlight = false;
      if (persistPending) {
        const { counts: c, ts: t } = persistPending;
        persistPending = null;
        persistFrecencySnapshot(c, t);
      }
    });
}

export function invalidateCache() {
  cachedRedirect = null;
  redirectSettingsPromise = null;
  resetDB();
}

function applyDecay(): void {
  if (!(frecencyCounts && lastDecayTs)) {
    lastDecayTs = Date.now();
    return;
  }
  const now = Date.now();
  const elapsed = now - lastDecayTs;
  if (elapsed < 3_600_000) {
    return;
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
}

function pruneFrecency(): void {
  if (!frecencyCounts) {
    return;
  }
  const keys = Object.keys(frecencyCounts);
  if (keys.length <= MAX_FRECENCY_ENTRIES) {
    return;
  }
  const entries = Object.entries(frecencyCounts);
  entries.sort((a, b) => b[1] - a[1]);
  const pruned = emptyFrecencyCounts();
  for (const [trigger, count] of entries.slice(0, MAX_FRECENCY_ENTRIES)) {
    pruned[trigger] = count;
  }
  frecencyCounts = pruned;
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
  if (frecencyCounts) {
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
        const stored = result?.value ?? "";
        if (stored) {
          const pipeIdx = stored.indexOf("|");
          lastDecayTs =
            pipeIdx > 0
              ? parseInt(stored.substring(0, pipeIdx), 10) || Date.now()
              : Date.now();
          frecencyCounts =
            pipeIdx === -1
              ? emptyFrecencyCounts()
              : parseFrecencyCompact(stored.substring(pipeIdx + 1));
        } else {
          frecencyCounts = emptyFrecencyCounts();
          lastDecayTs = Date.now();
        }

        applyDecay();
        pruneFrecency();
        topFrecency = frecencyCounts
          ? buildTopFrecency(frecencyCounts, FRECENCY_COOKIE_ENTRIES)
          : [];
        persistFrecencySnapshot(frecencyCounts, lastDecayTs);
      } catch {
        frecencyCounts = emptyFrecencyCounts();
        topFrecency = [];
        lastDecayTs = Date.now();
      }
    })().finally(() => {
      loadFrecencyPromise = null;
    });
  }

  return loadFrecencyPromise;
}

export function trackBangUsage(trigger: string) {
  if (!frecencyCounts) {
    frecencyCounts = emptyFrecencyCounts();
    topFrecency = [];
  }
  const nextCount = (frecencyCounts[trigger] || 0) + 1;
  frecencyCounts[trigger] = nextCount;
  updateTopFrecencyOnIncrement(
    topFrecency,
    trigger,
    nextCount,
    FRECENCY_COOKIE_ENTRIES
  );
  persistFrecencySnapshot(frecencyCounts, lastDecayTs);
}
