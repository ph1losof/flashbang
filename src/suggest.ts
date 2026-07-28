import { CH_CR, CH_FF, CH_NL, CH_SPACE, CH_TAB, CH_VTAB } from "./shared/chars";
import {
  JSON_HEADERS,
  SUGGEST_TRIGGER_PROVIDERS,
  SUGGEST_URLS,
} from "./shared/constants";
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
import { bangSuggestions } from "./suggest-bang";

const JSON_HEADERS_INIT = { headers: JSON_HEADERS };

export interface SuggestCoreSettings {
  bangPrefix: TriggerPrefix;
  customUrl: string | null;
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
  insertions: Array<{ index: number; value: string }>;
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
    } else {
      value += value ? ` ${term}` : term;
      termCount++;
    }
  }

  if (insertions.length === 0) {
    return null;
  }
  return { insertions, termCount, value };
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

function fillTemplate(url: string, encodedQuery: string): string {
  const parts = resolveTemplateParts(url);
  if (!parts) {
    return url;
  }
  return parts[0] + encodedQuery + parts[1];
}

function empty(query: string): Response {
  return new Response(`[${JSON.stringify(query)},[]]`, JSON_HEADERS_INIT);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
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
  if (value.length > 3 && !isStringArray(value[3])) {
    return false;
  }
  return (
    value.length < 5 ||
    (value[4] !== null &&
      typeof value[4] === "object" &&
      !Array.isArray(value[4]))
  );
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
    settings.snapPrefix
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
      cookieSettings.snapPrefix
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

  return {
    settings,
    rewrittenSuggestCookie,
  };
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
  allowUnsafeCustomUrls = false
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

  if (!endpoint) {
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

  try {
    const res = await fetch(
      fillTemplate(endpoint, encodeURIComponent(queryValue))
    );
    if (!res.ok) {
      return empty(query);
    }
    const body = await res.text();
    const payload: unknown = JSON.parse(body);
    if (!isSuggestionPayload(payload)) {
      return empty(query);
    }
    if (providerQuery) {
      payload[0] = query;
      const completions = payload[1] as string[];
      for (let i = 0; i < completions.length; i++) {
        completions[i] = restoreTriggers(completions[i], providerQuery);
      }
      return new Response(JSON.stringify(payload), JSON_HEADERS_INIT);
    }
    return new Response(body, JSON_HEADERS_INIT);
  } catch {
    return empty(query);
  }
}
