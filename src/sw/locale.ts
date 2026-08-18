import {
  canonicalLocaleTag,
  LOCALE_DISABLED,
  type LocaleSplit,
  localeChain,
  localeSplitOf,
  resolveLocaleValue,
} from "../shared/locale-table";

export { canonicalLocaleTag };

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

function applyTags(raw: readonly string[]): boolean {
  const tags: string[] = [];
  for (const value of raw) {
    const tag = canonicalLocaleTag(value);
    if (tag && !tags.includes(tag)) {
      tags.push(tag);
    }
  }
  const nextLang = localeChain(tags);
  if (initialized && sameChain(nextLang, langChain)) {
    return false;
  }
  initialized = true;
  langChain = nextLang;
  resolvedValues.length = 0;
  generation++;
  return true;
}

export function setActiveLocale(override: string | null): boolean {
  let tags: readonly string[];
  if (override === LOCALE_DISABLED) {
    tags = [];
  } else if (override) {
    tags = [override];
  } else {
    tags = browserLanguages();
  }
  if (!applyTags(tags)) {
    return false;
  }
  for (const listener of listeners) {
    listener();
  }
  return true;
}

function resolveForSplit(split: LocaleSplit): string {
  if (!initialized) {
    applyTags(browserLanguages());
  }
  const group = split.group;
  const cached = resolvedValues[group];
  if (cached !== undefined) {
    return cached;
  }
  const value = resolveLocaleValue(split.pattern, langChain);
  resolvedValues[group] = value;
  return value;
}

export function substituteLocale(prefix: string): string {
  if (prefix.indexOf("{") === -1) {
    return prefix;
  }
  const split = localeSplitOf(prefix);
  return split === null
    ? prefix
    : split.head + resolveForSplit(split) + split.tail;
}

export function localeSnapDomain(prefix: string): string | null {
  if (prefix.indexOf("{") === -1) {
    return null;
  }
  return localeSplitOf(prefix)?.pattern.snap ?? null;
}
