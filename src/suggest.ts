import { CH_CR, CH_FF, CH_NL, CH_SPACE, CH_TAB, CH_VTAB } from "./shared/chars";
import {
  JSON_HEADERS,
  SITE_SUGGESTION_MAX_BYTES,
  SITE_SUGGESTION_MIN_CODE_POINTS,
  SITE_SUGGESTION_SHAPE,
  SITE_SUGGESTION_TIMEOUT_MS,
  SUGGEST_TRIGGER_PROVIDERS,
  SUGGEST_URLS,
  TOP_K,
} from "./shared/constants";
import { localeChain } from "./shared/locale-table";
import { LOCALE_DISABLED, normalizeLocaleSetting } from "./shared/locale-tag";
import { readQueryParam } from "./shared/raw-query";
import { parsePartialSnapChain } from "./shared/snap-chain";
import {
  encodeSuggestCookieValue,
  parseSuggestCookieContextValueWithValidation,
  parseSuggestCookieValue,
  parseSuggestCookieValueWithValidation,
} from "./shared/suggest-cookie";
import { resolveTemplateParts } from "./shared/template";
import {
  DEFAULT_BANG_PREFIX,
  DEFAULT_SNAP_PREFIX,
  isTriggerPrefix,
  type TriggerPrefix,
} from "./shared/trigger-prefix";
import {
  addBangSuggestionMetaForTerminal,
  bangSuggestions,
  findBangSuggestionTerminal,
  resolveSiteSuggestionUrl,
  siteSuggestionShape,
} from "./suggest-bang";

const JSON_HEADERS_INIT = { headers: JSON_HEADERS };

export interface SuggestCoreSettings {
  bangPrefix: TriggerPrefix;
  customUrl: string | null;
  lang: string | null;
  provider: string;
  snapPrefix: TriggerPrefix;
  trigger: string;
}

export interface SuggestBangContext {
  frecent: Record<string, number>;
  custom: string[];
}

export interface SuggestSettings
  extends SuggestCoreSettings,
    SuggestBangContext {}

export interface PartialBang {
  chainPrefix?: string;
  partial: string;
  prefix: string;
  isSnap?: boolean;
  selectedTriggers?: readonly string[];
  triggerPrefix: TriggerPrefix;
}

function partialSnapChain(
  prefix: string,
  value: string,
  triggerPrefix: TriggerPrefix
): PartialBang | null {
  const chain = parsePartialSnapChain(value);
  if (!chain) {
    return null;
  }
  return {
    prefix,
    partial: chain.partial,
    isSnap: true,
    triggerPrefix,
    chainPrefix: chain.chainPrefix,
    selectedTriggers: chain.selectedTriggers,
  };
}

function isTrimWs(code: number): boolean {
  return (
    code === CH_SPACE ||
    code === CH_TAB ||
    code === CH_NL ||
    code === CH_VTAB ||
    code === CH_FF ||
    code === CH_CR
  );
}

interface ProviderQuery {
  bangTrigger: string | null;
  insertions: Array<{ index: number; value: string }>;
  snapTrigger: string | null;
  termCount: number;
  value: string;
}

function providerQueryWithoutTriggers(
  query: string,
  bangPrefix: TriggerPrefix,
  snapPrefix: TriggerPrefix
): ProviderQuery | null {
  if (query.indexOf(bangPrefix) === -1 && query.indexOf(snapPrefix) === -1) {
    return null;
  }

  const bangCode = bangPrefix.charCodeAt(0);
  const snapCode = snapPrefix.charCodeAt(0);
  let atBoundary = true;
  let hasTrigger = false;

  for (let i = 0; i < query.length; i++) {
    const code = query.charCodeAt(i);
    if (isTrimWs(code)) {
      atBoundary = true;
    } else {
      if (atBoundary && (code === bangCode || code === snapCode)) {
        hasTrigger = true;
        break;
      }
      atBoundary = false;
    }
  }
  if (!hasTrigger) {
    return null;
  }

  const insertions: ProviderQuery["insertions"] = [];
  let bangTrigger: string | null = null;
  let snapTrigger: string | null = null;
  let termCount = 0;
  let value = "";
  let index = 0;

  while (index < query.length) {
    while (index < query.length && isTrimWs(query.charCodeAt(index))) {
      index++;
    }
    const start = index;
    while (index < query.length && !isTrimWs(query.charCodeAt(index))) {
      index++;
    }
    if (start === index) {
      break;
    }

    const term = query.substring(start, index);
    const prefix = term.charAt(0);
    if (prefix === bangPrefix || prefix === snapPrefix) {
      insertions.push({ index: termCount, value: term });
      if (prefix === bangPrefix) {
        bangTrigger ??= term.substring(1);
      } else {
        snapTrigger ??= term.substring(1);
      }
    } else {
      value += value ? ` ${term}` : term;
      termCount++;
    }
  }

  if (insertions.length === 0) {
    return null;
  }
  return { bangTrigger, insertions, snapTrigger, termCount, value };
}

function restoreTriggers(
  completion: string,
  providerQuery: ProviderQuery
): string {
  const { insertions, termCount } = providerQuery;
  let start = 0;
  let end = completion.length;
  while (start < end && isTrimWs(completion.charCodeAt(start))) {
    start++;
  }
  while (end > start && isTrimWs(completion.charCodeAt(end - 1))) {
    end--;
  }

  const lastInsertion = insertions.length - 1;
  if (insertions[lastInsertion].index === 0) {
    let result = insertions[0].value;
    for (let i = 1; i < insertions.length; i++) {
      result += ` ${insertions[i].value}`;
    }
    return start === end
      ? result
      : `${result} ${completion.substring(start, end)}`;
  }
  if (insertions[0].index === termCount) {
    let result = start === end ? "" : completion.substring(start, end);
    let i = 0;
    while (i < insertions.length) {
      if (result) {
        result += " ";
      }
      result += insertions[i].value;
      i++;
    }
    return result;
  }

  let result = "";
  let insertionIndex = 0;
  let completionTerm = 0;
  let position = start;
  while (position < end) {
    while (position < end && isTrimWs(completion.charCodeAt(position))) {
      position++;
    }
    const termStart = position;
    while (position < end && !isTrimWs(completion.charCodeAt(position))) {
      position++;
    }
    if (termStart === position) {
      break;
    }

    while (
      insertionIndex < insertions.length &&
      insertions[insertionIndex].index === completionTerm &&
      completionTerm < termCount
    ) {
      if (result) {
        result += " ";
      }
      result += insertions[insertionIndex++].value;
    }
    if (result) {
      result += " ";
    }
    result += completion.substring(termStart, position);
    completionTerm++;
  }

  while (insertionIndex < insertions.length) {
    if (result) {
      result += " ";
    }
    result += insertions[insertionIndex++].value;
  }
  return result;
}

function providerBangTerminal(
  providerQuery: ProviderQuery,
  settings: SuggestSettings
): number {
  const value = providerQuery.bangTrigger ?? providerQuery.snapTrigger;
  if (!value) {
    return -1;
  }
  const comma = value.indexOf(",");
  const trigger = (comma < 0 ? value : value.substring(0, comma)).toLowerCase();
  if (settings.custom.length > 0 && settings.custom.includes(trigger)) {
    return -1;
  }
  return trigger ? findBangSuggestionTerminal(trigger) : -1;
}

function fillTemplate(url: string, encodedQuery: string): string {
  const parts = resolveTemplateParts(url);
  if (!parts) {
    return url;
  }
  return parts[0] + encodedQuery + parts[1];
}

const NO_LANGUAGE_CHAIN: readonly string[] = [];

const LANGUAGE_CHAIN_LIMIT = 64;
const languageChains = new Map<string, readonly string[]>();

function suggestLanguageChain(lang: string | null): readonly string[] {
  if (!lang || lang === LOCALE_DISABLED) {
    return NO_LANGUAGE_CHAIN;
  }
  const cached = languageChains.get(lang);
  if (cached !== undefined) {
    return cached;
  }
  if (languageChains.size >= LANGUAGE_CHAIN_LIMIT) {
    languageChains.clear();
  }
  const chain = localeChain([lang]);
  languageChains.set(lang, chain);
  return chain;
}

function empty(query: string): Response {
  return new Response(`[${JSON.stringify(query)},[]]`, JSON_HEADERS_INIT);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isSuggestionExtra(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSuggestionPayload(value: unknown): value is unknown[] {
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    value.length > 5 ||
    typeof value[0] !== "string" ||
    !isStringArray(value[1])
  ) {
    return false;
  }

  if (value.length > 2 && !isStringArray(value[2])) {
    return false;
  }
  if (value.length === 4 && isSuggestionExtra(value[3])) {
    return true;
  }
  if (value.length > 3 && !isStringArray(value[3])) {
    return false;
  }
  return value.length < 5 || isSuggestionExtra(value[4]);
}

function siteSpecificCompletions(shape: number, payload: unknown): string[] {
  const completions: string[] = [];
  switch (shape) {
    case SITE_SUGGESTION_SHAPE.opensearch: {
      const values = Array.isArray(payload) ? payload[1] : undefined;
      if (Array.isArray(values)) {
        for (let i = 0; i < values.length && completions.length < TOP_K; i++) {
          if (typeof values[i] === "string") {
            completions.push(values[i]);
          }
        }
      }
      break;
    }
    case SITE_SUGGESTION_SHAPE.amazon: {
      const values = (payload as { suggestions?: unknown } | null)?.suggestions;
      if (Array.isArray(values)) {
        for (let i = 0; i < values.length && completions.length < TOP_K; i++) {
          const item = values[i];
          const value =
            typeof item === "object" && item !== null
              ? (item as { value?: unknown }).value
              : undefined;
          if (typeof value === "string") {
            completions.push(value);
          }
        }
      }
      break;
    }
    case SITE_SUGGESTION_SHAPE.npms:
      if (Array.isArray(payload)) {
        for (let i = 0; i < payload.length && completions.length < TOP_K; i++) {
          const item = payload[i];
          const value =
            typeof item === "object" && item !== null
              ? (item as { package?: { name?: unknown } }).package?.name
              : undefined;
          if (typeof value === "string") {
            completions.push(value);
          }
        }
      }
      break;
    case SITE_SUGGESTION_SHAPE.reddit: {
      const values = (
        payload as {
          data?: { children?: Array<{ data?: { display_name?: unknown } }> };
        } | null
      )?.data?.children;
      if (values) {
        for (let i = 0; i < values.length && completions.length < TOP_K; i++) {
          const value = values[i].data?.display_name;
          if (typeof value === "string") {
            completions.push(value);
          }
        }
      }
      break;
    }
    case SITE_SUGGESTION_SHAPE.crates: {
      const values = (payload as { crates?: Array<{ name?: unknown }> } | null)
        ?.crates;
      if (values) {
        for (let i = 0; i < values.length && completions.length < TOP_K; i++) {
          const value = values[i].name;
          if (typeof value === "string") {
            completions.push(value);
          }
        }
      }
      break;
    }
    case SITE_SUGGESTION_SHAPE.algolia: {
      const result = payload as {
        hits?: Array<{ full_name?: unknown; title?: unknown }>;
        items?: Array<{ full_name?: unknown; title?: unknown }>;
      } | null;
      const values = result?.hits ?? result?.items;
      if (values) {
        for (let i = 0; i < values.length && completions.length < TOP_K; i++) {
          const item = values[i];
          const value =
            typeof item.title === "string" ? item.title : item.full_name;
          if (typeof value === "string") {
            completions.push(value);
          }
        }
      }
      break;
    }
    case SITE_SUGGESTION_SHAPE.strings: {
      const values = Array.isArray(payload)
        ? payload
        : (payload as { data?: unknown } | null)?.data;
      if (Array.isArray(values)) {
        for (let i = 0; i < values.length && completions.length < TOP_K; i++) {
          if (typeof values[i] === "string") {
            completions.push(values[i]);
          }
        }
      }
      break;
    }
    case SITE_SUGGESTION_SHAPE.results: {
      const values = (payload as { results?: unknown } | null)?.results;
      if (Array.isArray(values)) {
        for (let i = 0; i < values.length && completions.length < TOP_K; i++) {
          const item = values[i] as {
            name?: unknown;
          } | null;
          let value = item?.name;
          if (value && typeof value === "object") {
            const translations = value as Record<string, unknown>;
            value = translations["en-US"];
            if (typeof value !== "string") {
              for (const locale in translations) {
                const translation = translations[locale];
                if (typeof translation === "string") {
                  value = translation;
                  break;
                }
              }
            }
          }
          if (typeof value === "string") {
            completions.push(value);
          }
        }
      }
      break;
    }
    case SITE_SUGGESTION_SHAPE.maven: {
      const values = (
        payload as { response?: { docs?: Array<{ id?: unknown }> } } | null
      )?.response?.docs;
      if (values) {
        for (let i = 0; i < values.length && completions.length < TOP_K; i++) {
          const value = values[i].id;
          if (typeof value === "string") {
            completions.push(value);
          }
        }
      }
      break;
    }
  }
  return completions;
}

function hasMinimumCodePoints(value: string, minimum: number): boolean {
  let offset = 0;
  for (let count = 0; count < minimum; count++) {
    if (offset >= value.length) {
      return false;
    }
    const code = value.charCodeAt(offset++);
    if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      offset < value.length &&
      (value.charCodeAt(offset) & 0xfc00) === 0xdc00
    ) {
      offset++;
    }
  }
  return true;
}

export function parsePartialBang(
  q: string,
  bangPrefix: TriggerPrefix = DEFAULT_BANG_PREFIX,
  snapPrefix: TriggerPrefix = DEFAULT_SNAP_PREFIX
): PartialBang | null {
  let start = 0;
  let end = q.length;

  while (start < end && isTrimWs(q.charCodeAt(start))) {
    start++;
  }
  while (end > start && isTrimWs(q.charCodeAt(end - 1))) {
    end--;
  }
  if (start === end) {
    return null;
  }

  const c0 = q.charCodeAt(start);
  const bangCode = bangPrefix.charCodeAt(0);
  const snapCode = snapPrefix.charCodeAt(0);

  if (c0 === bangCode || c0 === snapCode) {
    const isSnap = c0 === snapCode;
    let isChain = false;
    if (isSnap && end - start > 3) {
      for (let i = start + 1; i < end; i++) {
        const c = q.charCodeAt(i);
        if (c === CH_SPACE) {
          return null;
        }
        if (c === 44) {
          isChain = true;
        }
      }
    } else {
      for (let i = start + 1; i < end; i++) {
        if (q.charCodeAt(i) === CH_SPACE) {
          return null;
        }
      }
    }
    const value = q.substring(start + 1, end);
    if (isChain) {
      return partialSnapChain("", value, snapPrefix);
    }
    return {
      prefix: "",
      partial: value.toLowerCase(),
      isSnap: isSnap || undefined,
      triggerPrefix: isSnap ? snapPrefix : bangPrefix,
    };
  }

  for (let i = end - 2; i >= start; i--) {
    const ci = q.charCodeAt(i);
    const ci1 = q.charCodeAt(i + 1);
    if (ci !== CH_SPACE || (ci1 !== bangCode && ci1 !== snapCode)) {
      continue;
    }
    if (end < q.length) {
      return null;
    }
    const triggerStart = i + 2;
    const isSnap = ci1 === snapCode;
    let isChain = false;
    if (isSnap && end - triggerStart >= 3) {
      for (let j = triggerStart; j < end; j++) {
        const c = q.charCodeAt(j);
        if (c === CH_SPACE) {
          return null;
        }
        if (c === 44) {
          isChain = true;
        }
      }
    } else {
      for (let j = triggerStart; j < end; j++) {
        if (q.charCodeAt(j) === CH_SPACE) {
          return null;
        }
      }
    }
    const prefix = q.substring(start, i + 1);
    const value = q.substring(triggerStart, end);
    if (isChain) {
      return partialSnapChain(prefix, value, snapPrefix);
    }
    return {
      prefix,
      partial: value.toLowerCase(),
      isSnap: isSnap || undefined,
      triggerPrefix: isSnap ? snapPrefix : bangPrefix,
    };
  }

  return null;
}

function resolveEndpoint(provider: string, trigger: string): string | null {
  return (
    SUGGEST_URLS[provider] ??
    (provider === "none"
      ? null
      : (SUGGEST_URLS[SUGGEST_TRIGGER_PROVIDERS[trigger]] ?? null))
  );
}

export function parseCookie(request: Request): SuggestSettings {
  const header = request.headers.get("Cookie") || "";
  return parseCookieInternalWithRewrite(header, true, false).settings;
}

interface SuggestSettingsParseResult {
  settings: SuggestSettings;
  rewrittenSuggestCookie: string | null;
}

function parseCookieInternalWithRewrite(
  header: string,
  includeBangContext: boolean,
  includeRewrite: boolean
): SuggestSettingsParseResult {
  const suggestRaw = readCookieValue(header, "suggest");
  if (suggestRaw === null) {
    return {
      settings: defaultSettings(),
      rewrittenSuggestCookie: null,
    };
  }

  if (!(includeRewrite && includeBangContext)) {
    return {
      settings: parseSuggestCookieValue(suggestRaw, includeBangContext),
      rewrittenSuggestCookie: null,
    };
  }

  const { settings, hasInvalidContext } = parseSuggestCookieValueWithValidation(
    suggestRaw,
    includeBangContext,
    true
  );
  if (!hasInvalidContext) {
    return { settings, rewrittenSuggestCookie: null };
  }

  const rewritten = encodeSuggestCookieValue(
    settings.provider,
    settings.trigger,
    settings.customUrl || "",
    [],
    {},
    settings.bangPrefix,
    settings.snapPrefix,
    settings.lang
  );

  return {
    settings: { ...settings, frecent: {}, custom: [] },
    rewrittenSuggestCookie: rewritten,
  };
}

export interface SuggestSettingsWithCleanup {
  settings: SuggestSettings;
  rewrittenSuggestCookie: string | null;
}

export function parseBangSettingsFromRequestWithCleanup(
  request: Request,
  settings: SuggestSettings
): SuggestSettingsWithCleanup {
  const suggestRaw = readCookieValue(
    request.headers.get("Cookie") || "",
    "suggest"
  );
  if (suggestRaw === null) {
    return { settings, rewrittenSuggestCookie: null };
  }

  const { custom, frecent, hasInvalidContext } =
    parseSuggestCookieContextValueWithValidation(suggestRaw, true);
  settings.custom = custom;
  settings.frecent = frecent;
  if (!hasInvalidContext) {
    return { settings, rewrittenSuggestCookie: null };
  }

  const cookieSettings = parseSuggestCookieValue(suggestRaw, false);
  settings.custom = [];
  settings.frecent = {};
  return {
    settings,
    rewrittenSuggestCookie: encodeSuggestCookieValue(
      cookieSettings.provider,
      cookieSettings.trigger,
      cookieSettings.customUrl || "",
      [],
      {},
      cookieSettings.bangPrefix,
      cookieSettings.snapPrefix,
      cookieSettings.lang
    ),
  };
}

export function parseSettingsFromRawUrlWithCleanup(
  rawUrl: string,
  request: Request,
  spOverride?: string | null,
  includeBangContext = true,
  bangPrefixOverride?: string | null,
  snapPrefixOverride?: string | null
): SuggestSettingsWithCleanup {
  const { settings, rewrittenSuggestCookie } = parseCookieInternalWithRewrite(
    request.headers.get("Cookie") || "",
    includeBangContext,
    true
  );

  const sp =
    spOverride === undefined ? readQueryParam(rawUrl, "sp") : spOverride;
  if (sp) {
    settings.provider = sp;
  }
  applyTriggerPrefixOverrides(
    rawUrl,
    settings,
    bangPrefixOverride,
    snapPrefixOverride
  );
  applyLanguageOverride(rawUrl, settings);

  return {
    settings,
    rewrittenSuggestCookie,
  };
}

function applyLanguageOverride(
  rawUrl: string,
  settings: SuggestSettings
): void {
  if (settings.lang) {
    return;
  }
  const raw = readQueryParam(rawUrl, "lang");
  settings.lang = raw ? normalizeLocaleSetting(raw) : null;
}

export function parseSettingsFromRawUrl(
  rawUrl: string,
  request: Request,
  spOverride?: string | null,
  includeBangContext = true,
  bangPrefixOverride?: string | null,
  snapPrefixOverride?: string | null
): SuggestSettings {
  const settings = parseCookieInternalWithRewrite(
    request.headers.get("Cookie") || "",
    includeBangContext,
    false
  ).settings;

  const sp =
    spOverride === undefined ? readQueryParam(rawUrl, "sp") : spOverride;
  if (sp) {
    settings.provider = sp;
  }
  applyTriggerPrefixOverrides(
    rawUrl,
    settings,
    bangPrefixOverride,
    snapPrefixOverride
  );
  applyLanguageOverride(rawUrl, settings);

  return settings;
}

export function parseSettings(url: URL, request: Request): SuggestSettings {
  return parseSettingsFromRawUrl(url.href, request);
}

function defaultSettings(): SuggestSettings {
  return {
    bangPrefix: DEFAULT_BANG_PREFIX,
    provider: "default",
    snapPrefix: DEFAULT_SNAP_PREFIX,
    trigger: "g",
    customUrl: null,
    lang: null,
    frecent: {},
    custom: [],
  };
}

function applyTriggerPrefixOverrides(
  rawUrl: string,
  settings: SuggestSettings,
  bangPrefixOverride?: string | null,
  snapPrefixOverride?: string | null
): void {
  if (
    bangPrefixOverride === undefined &&
    snapPrefixOverride === undefined &&
    !(rawUrl.includes("bp=") || rawUrl.includes("np="))
  ) {
    return;
  }
  const bangPrefix =
    bangPrefixOverride === undefined
      ? readQueryParam(rawUrl, "bp")
      : bangPrefixOverride;
  const snapPrefix =
    snapPrefixOverride === undefined
      ? readQueryParam(rawUrl, "np")
      : snapPrefixOverride;
  if (
    isTriggerPrefix(bangPrefix) &&
    isTriggerPrefix(snapPrefix) &&
    bangPrefix !== snapPrefix
  ) {
    settings.bangPrefix = bangPrefix;
    settings.snapPrefix = snapPrefix;
  }
}

function readCookieValue(header: string, name: string): string | null {
  const prefix = `${name}=`;
  const pLen = prefix.length;
  let i = header.indexOf(prefix);
  while (i !== -1) {
    let separator = i - 1;
    while (separator >= 0) {
      const code = header.charCodeAt(separator);
      if (code !== 32 && code !== 9) {
        break;
      }
      separator--;
    }
    if (separator < 0 || header.charCodeAt(separator) === 59) {
      const end = header.indexOf(";", i + pLen);
      return end === -1
        ? header.substring(i + pLen)
        : header.substring(i + pLen, end);
    }
    i = header.indexOf(prefix, i + 1);
  }
  return null;
}

export async function suggest(
  query: string,
  settings: SuggestSettings,
  bangOverride?: PartialBang | null,
  allowUnsafeCustomUrls = false,
  siteSpecificForward = false
): Promise<Response> {
  const bang =
    bangOverride === undefined
      ? parsePartialBang(query, settings.bangPrefix, settings.snapPrefix)
      : bangOverride;
  if (bang) {
    return bangSuggestions(
      query,
      bang.prefix,
      bang.partial,
      settings.frecent,
      settings.custom,
      bang.triggerPrefix,
      bang.chainPrefix,
      bang.selectedTriggers
    );
  }

  const { provider, trigger, customUrl } = settings;
  let endpoint: string | null;
  if (provider === "custom") {
    endpoint = allowUnsafeCustomUrls ? customUrl : null;
  } else {
    endpoint = resolveEndpoint(provider, trigger);
  }
  if (!(siteSpecificForward || endpoint)) {
    return empty(query);
  }

  const providerQuery = providerQueryWithoutTriggers(
    query,
    settings.bangPrefix,
    settings.snapPrefix
  );
  const queryValue = providerQuery?.value ?? query;
  if (!queryValue) {
    return empty(query);
  }

  let bangTerminal = -1;
  let encodedQuery: string | null = null;
  let siteUrl: string | null = null;
  if (siteSpecificForward && providerQuery?.bangTrigger) {
    bangTerminal = providerBangTerminal(providerQuery, settings);
    if (bangTerminal >= 0) {
      encodedQuery = encodeURIComponent(queryValue);
      siteUrl = resolveSiteSuggestionUrl(
        bangTerminal,
        encodedQuery,
        suggestLanguageChain(settings.lang)
      );
      if (siteUrl) {
        if (
          !hasMinimumCodePoints(queryValue, SITE_SUGGESTION_MIN_CODE_POINTS)
        ) {
          return empty(query);
        }
      }
    }
  }

  if (!(siteUrl || endpoint)) {
    return empty(query);
  }

  try {
    encodedQuery ??= encodeURIComponent(queryValue);
    const requestUrl = siteUrl ?? fillTemplate(endpoint!, encodedQuery);
    const res = siteUrl
      ? await fetch(requestUrl, {
          headers: {
            "User-Agent":
              "flashbang-suggest/1.0 (+https://github.com/ph1losof/flashbang)",
          },
          signal: AbortSignal.timeout(SITE_SUGGESTION_TIMEOUT_MS),
        })
      : await fetch(requestUrl);
    if (!res.ok) {
      return empty(query);
    }
    if (siteUrl) {
      const contentLength = Number(res.headers.get("Content-Length"));
      if (
        Number.isFinite(contentLength) &&
        contentLength > SITE_SUGGESTION_MAX_BYTES
      ) {
        return empty(query);
      }
    }
    const body = await res.text();
    if (siteUrl && body.length > SITE_SUGGESTION_MAX_BYTES) {
      return empty(query);
    }
    const parsed: unknown = JSON.parse(body);
    const payload: unknown = siteUrl
      ? [
          queryValue,
          siteSpecificCompletions(siteSuggestionShape(bangTerminal), parsed),
        ]
      : parsed;
    if (!isSuggestionPayload(payload)) {
      return empty(query);
    }
    if (providerQuery) {
      payload[0] = query;
      const completions = payload[1] as string[];
      for (let i = 0; i < completions.length; i++) {
        completions[i] = restoreTriggers(completions[i], providerQuery);
      }
      if (payload.length === 4 && isSuggestionExtra(payload[3])) {
        payload[4] = payload[3];
        payload[3] = [];
      }
      if (bangTerminal < 0) {
        bangTerminal = providerBangTerminal(providerQuery, settings);
      }
      if (bangTerminal >= 0) {
        addBangSuggestionMetaForTerminal(
          payload,
          completions.length,
          bangTerminal
        );
      }
      return new Response(JSON.stringify(payload), JSON_HEADERS_INIT);
    }
    return new Response(body, JSON_HEADERS_INIT);
  } catch {
    return empty(query);
  }
}
