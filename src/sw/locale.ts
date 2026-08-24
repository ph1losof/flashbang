import {
  activeLocaleTable,
  canonicalLocaleTag,
  LOCALE_DISABLED,
  type LocaleSplit,
  type LocaleTable,
} from "../shared/locale-tag";

export { canonicalLocaleTag };

interface LocaleTableUnavailableError extends Error {
  readonly localeTableUnavailable: true;
}

let pendingTags: readonly string[] | null = null;
let unavailable: LocaleTableUnavailableError | null = null;

let generation = 1;
let langChain: readonly string[] = [];
let initialized = false;

const resolvedValues: (string | undefined)[] = [];

export function localeGeneration(): number {
  return generation;
}

const listeners: Array<() => void> = [];

export function onLocaleChange(listener: () => void): void {
  listeners.push(listener);
}

function notifyLocaleChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") {
    return [];
  }
  const list = navigator.languages;
  if (list && list.length > 0) {
    return list;
  }
  return navigator.language ? [navigator.language] : [];
}

function sameChain(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function applyTags(raw: readonly string[], loaded: LocaleTable): boolean {
  const tags: string[] = [];
  for (const value of raw) {
    const tag = canonicalLocaleTag(value);
    if (tag && !tags.includes(tag)) {
      tags.push(tag);
    }
  }
  const nextLang = loaded.localeChain(tags);
  if (initialized && sameChain(nextLang, langChain)) {
    return false;
  }
  initialized = true;
  langChain = nextLang;
  resolvedValues.length = 0;
  generation++;
  return true;
}

function requestedTags(override: string | null): readonly string[] {
  if (override === LOCALE_DISABLED) {
    return [];
  }
  return override ? [override] : browserLanguages();
}

export function localeTableUnavailable(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    error === unavailable &&
    (error as Partial<LocaleTableUnavailableError>).localeTableUnavailable ===
      true
  );
}

function requireTable(): LocaleTable {
  const loaded = activeLocaleTable();
  if (loaded) {
    return loaded;
  }
  if (!unavailable) {
    unavailable = Object.assign(new Error("Locale table is not installed"), {
      localeTableUnavailable: true as const,
    });
  }
  throw unavailable;
}

export function setActiveLocale(override: string | null): boolean {
  const tags = requestedTags(override);
  const loaded = activeLocaleTable();
  if (!loaded) {
    // Nothing can have been substituted yet, so there is no cache to drop and
    // no listener to run. The first substitution applies these tags instead.
    pendingTags = tags;
    return false;
  }
  if (!applyTags(tags, loaded)) {
    return false;
  }
  notifyLocaleChange();
  return true;
}

function resolveForSplit(split: LocaleSplit, loaded: LocaleTable): string {
  if (!initialized) {
    applyTags(pendingTags ?? browserLanguages(), loaded);
    pendingTags = null;
  }
  const group = split.group;
  const cached = resolvedValues[group];
  if (cached !== undefined) {
    return cached;
  }
  const value = loaded.resolveLocaleValue(split.pattern, langChain);
  resolvedValues[group] = value;
  return value;
}

export function substituteLocale(prefix: string): string {
  if (prefix.indexOf("{") === -1) {
    return prefix;
  }
  const loaded = requireTable();
  const split = loaded.localeSplitOf(prefix);
  return split === null
    ? prefix
    : split.head + resolveForSplit(split, loaded) + split.tail;
}

export function localeSnapDomain(prefix: string): string | null {
  if (prefix.indexOf("{") === -1) {
    return null;
  }
  return requireTable().localeSplitOf(prefix)?.pattern.snap ?? null;
}
