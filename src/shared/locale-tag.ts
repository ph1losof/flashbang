/**
 * Locale identifiers and shapes that carry no edition data.
 *
 * Split out of `locale-table.ts` so the cold fallback can parse tags, validate
 * a stored setting, and describe a `{lang}` host without pulling the 826-entry
 * edition table onto the first-redirect path. The table itself is loaded only
 * when a destination actually needs substituting — see `sw/locale.ts`.
 */

const TAG_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}$/;

export function canonicalLocaleTag(value: string): string | null {
  return canonicalizeLowered(value.trim().toLowerCase());
}

function canonicalizeLowered(lowered: string): string | null {
  const tag =
    lowered.indexOf("_") === -1 ? lowered : lowered.replaceAll("_", "-");
  return TAG_PATTERN.test(tag) ? tag : null;
}

export const LOCALE_DISABLED = "none";

export function normalizeLocaleSetting(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  return trimmed === LOCALE_DISABLED
    ? LOCALE_DISABLED
    : canonicalizeLowered(trimmed);
}

export interface LocalePattern {
  readonly aliases: string;
  readonly fallback: string;
  readonly host: string;
  readonly snap: string;
  readonly supported: string;
}

export interface LocaleSplit {
  readonly head: string;
  readonly group: number;
  readonly pattern: LocalePattern;
  readonly tail: string;
}

/**
 * The edition-data half of the locale table, supplied by whoever loaded it
 * rather than imported here.
 *
 * Only a destination whose host carries `{lang}` needs that data, and on the
 * cold first-redirect path most do not — it is ~1.8 KiB Brotli of the cold
 * bundle's budget. So this module holds a slot: `locale-table.ts` fills it on
 * load, which every static importer gets for free, while the cold fallback
 * imports it dynamically for the queries that actually reach a `{lang}` host.
 */
export interface LocaleTable {
  localeChain: (tags: readonly string[]) => string[];
  localeSplitOf: (prefix: string) => LocaleSplit | null;
  resolveLocaleValue: (
    pattern: LocalePattern,
    chain: readonly string[]
  ) => string;
}

let installed: LocaleTable | null = null;

export function installLocaleTable(table: LocaleTable): void {
  installed ??= table;
}

export function activeLocaleTable(): LocaleTable | null {
  return installed;
}
