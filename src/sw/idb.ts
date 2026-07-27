import {
  FRECENCY_HALF_LIFE_MS,
  MAX_FRECENCY_ENTRIES,
  TOP_FRECENCY_ENTRIES,
} from "../shared/constants";
import {
  parseFrecencyCompact,
  serializeFrecencyCompact,
} from "../shared/frecency-serial";
import { idbWrap, openDB, resetDB } from "../shared/idb";
import {
  buildTopFrecency,
  type TopFrecencyEntry,
  updateTopFrecencyOnIncrement,
} from "./frecency";
import type { RedirectSettings } from "./redirect";
import {
  createRedirectSettingsBundle,
  defaultRedirectSettings,
  deleteRedirectSettingsSnapshot,
  type PreparedRedirectSettings,
  persistRedirectSettingsBundle,
  prepareRedirectSettings,
} from "./redirect-settings";

interface FrecencySnapshot {
  counts: Record<string, number> | null;
  ts: number;
}

let persistPromise: Promise<void> | null = null;
let persistPending: FrecencySnapshot | null = null;
let cachedRedirect: RedirectSettings | null = null;
let redirectSettingsGeneration = 0;
let redirectSettingsPromise: Promise<RedirectSettings> | null = null;
let redirectSettingsInvalidationPromise: Promise<void> | null = null;
let redirectSettingsPersistencePromise: Promise<void> | null = null;
let frecencyCounts: Record<string, number> | null = null;
let frecencyLoaded = false;
let loadFrecencyPromise: Promise<void> | null = null;
let topFrecency: TopFrecencyEntry[] = [];
let lastDecayTs: number = 0;

function emptyFrecencyCounts(): Record<string, number> {
  return Object.create(null) as Record<string, number>;
}

export function getCachedSettings(): RedirectSettings | null {
  return cachedRedirect;
}

export function seedRedirectSettings(settings: RedirectSettings): void {
  cachedRedirect = settings;
}

function persistRedirectSettings(
  prepared: PreparedRedirectSettings,
  catalogVersion: string,
  generation: number
): RedirectSettings {
  const bundle = createRedirectSettingsBundle(prepared.snapshot);
  if (generation !== redirectSettingsGeneration) {
    return bundle.settings;
  }
  cachedRedirect = bundle.settings;
  const persistence = persistRedirectSettingsBundle(bundle, catalogVersion);
  let current: Promise<void>;
  current = persistence
    .catch(() => {
      resetDB();
    })
    .finally(() => {
      if (redirectSettingsPersistencePromise === current) {
        redirectSettingsPersistencePromise = null;
      }
    });
  redirectSettingsPersistencePromise = current;
  return bundle.settings;
}

export function waitForRedirectSettingsPersistence(): Promise<void> {
  return redirectSettingsPersistencePromise ?? Promise.resolve();
}

export function readRedirectSettings(
  prepared?: Promise<PreparedRedirectSettings>,
  catalogVersion = "",
  bangDataReady: Promise<void> = Promise.resolve()
): Promise<RedirectSettings> {
  const cached = getCachedSettings();
  if (cached) {
    return Promise.resolve(cached);
  }

  if (!redirectSettingsPromise) {
    const generation = redirectSettingsGeneration;
    const ready = bangDataReady.then(
      () => true,
      () => false
    );
    let current: Promise<RedirectSettings>;
    current = (async () => {
      await redirectSettingsInvalidationPromise;
      let value: PreparedRedirectSettings;
      try {
        value = await (prepared ?? prepareRedirectSettings(catalogVersion));
      } catch {
        const settings = defaultRedirectSettings();
        if (generation === redirectSettingsGeneration) {
          cachedRedirect = settings;
        }
        resetDB();
        return settings;
      }
      let settings: RedirectSettings;
      if (value.settings) {
        settings = value.settings;
      } else if (await ready) {
        try {
          settings = persistRedirectSettings(value, catalogVersion, generation);
        } catch {
          settings = defaultRedirectSettings();
        }
      } else {
        settings = defaultRedirectSettings();
      }
      if (generation === redirectSettingsGeneration) {
        cachedRedirect = settings;
      }
      return settings;
    })().finally(() => {
      if (redirectSettingsPromise === current) {
        redirectSettingsPromise = null;
      }
    });
    redirectSettingsPromise = current;
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

export function invalidateCache(): Promise<void> {
  redirectSettingsGeneration++;
  const pending = [
    redirectSettingsInvalidationPromise,
    redirectSettingsPersistencePromise,
    redirectSettingsPromise,
  ].filter(
    (promise): promise is Promise<void> | Promise<RedirectSettings> =>
      promise !== null
  );
  cachedRedirect = null;
  redirectSettingsPromise = null;
  resetDB();
  const invalidating = Promise.allSettled(pending).then(async () => {
    cachedRedirect = null;
    resetDB();
    await deleteRedirectSettingsSnapshot().catch(() => {
      resetDB();
    });
  });
  let current: Promise<void>;
  current = invalidating.finally(() => {
    if (redirectSettingsInvalidationPromise === current) {
      redirectSettingsInvalidationPromise = null;
    }
  });
  redirectSettingsInvalidationPromise = current;
  return current;
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
  const decayed = applyDecay();
  const pruned = pruneFrecency();
  shouldPersist = decayed || pruned || shouldPersist;
  topFrecency = buildTopFrecency(frecencyCounts, TOP_FRECENCY_ENTRIES);
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
  topMembershipChanged: boolean;
  topChanged: boolean;
} {
  if (!frecencyCounts) {
    frecencyCounts = emptyFrecencyCounts();
    topFrecency = [];
  }
  if (!lastDecayTs) {
    lastDecayTs = Date.now();
  }
  const wasTop = topFrecency.some((entry) => entry.trigger === trigger);
  const nextCount = (frecencyCounts[trigger] || 0) + 1;
  frecencyCounts[trigger] = nextCount;
  updateTopFrecencyOnIncrement(
    topFrecency,
    trigger,
    nextCount,
    TOP_FRECENCY_ENTRIES
  );
  pruneFrecency();
  const topChanged = topFrecency.some((entry) => entry.trigger === trigger);
  return {
    persistence: persistFrecencySnapshot(frecencyCounts, lastDecayTs),
    topMembershipChanged: !wasTop && topChanged,
    topChanged,
  };
}

export function resetIdbStateForTests(): void {
  persistPromise = null;
  persistPending = null;
  cachedRedirect = null;
  redirectSettingsGeneration = 0;
  redirectSettingsPromise = null;
  redirectSettingsInvalidationPromise = null;
  redirectSettingsPersistencePromise = null;
  frecencyCounts = null;
  frecencyLoaded = false;
  loadFrecencyPromise = null;
  topFrecency = [];
  lastDecayTs = 0;
  resetDB();
}
