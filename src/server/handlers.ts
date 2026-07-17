import { canonicalizePublicOrigin, opensearch } from "../opensearch";
import { COOKIE_MAX_AGE_S } from "../shared/constants";
import { readSuggestQueryParams } from "../shared/raw-query";
import { readOrigin } from "../shared/raw-url";
import {
  DEFAULT_BANG_PREFIX,
  DEFAULT_SNAP_PREFIX,
} from "../shared/trigger-prefix";
import {
  type PartialBang,
  parseBangSettingsFromRequestWithCleanup,
  parsePartialBang,
  parseSettingsFromRawUrl,
  parseSettingsFromRawUrlWithCleanup,
  type SuggestSettings,
  suggest,
} from "../suggest";

const MISSING_Q = "Missing q parameter";

export interface PublicOriginEnvironment {
  PUBLIC_ORIGIN?: string;
}

export interface SuggestEnvironment {
  ALLOW_UNSAFE_CUSTOM_SUGGEST_URLS?: string;
}

interface ServerEnvironment
  extends PublicOriginEnvironment,
    SuggestEnvironment {}

function runtimeEnvironment(): ServerEnvironment {
  return typeof process === "undefined"
    ? {}
    : {
        ALLOW_UNSAFE_CUSTOM_SUGGEST_URLS:
          process.env.ALLOW_UNSAFE_CUSTOM_SUGGEST_URLS,
        PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN,
      };
}

export function handleSuggestRequest(
  request: Request,
  environment: SuggestEnvironment = runtimeEnvironment()
): Promise<Response> {
  const rawUrl = request.url;
  const [q, sp, bp, np] = readSuggestQueryParams(rawUrl);
  if (!q) {
    return Promise.resolve(
      new Response(MISSING_Q, {
        headers: { "Cache-Control": "no-store" },
        status: 400,
      })
    );
  }
  const defaultBang = parsePartialBang(q);
  let settings: SuggestSettings;
  let rewrittenSuggestCookie: string | null;
  let bang: PartialBang | null;
  if (defaultBang) {
    ({ settings, rewrittenSuggestCookie } = parseSettingsFromRawUrlWithCleanup(
      rawUrl,
      request,
      sp,
      true,
      bp,
      np
    ));
    bang =
      settings.bangPrefix === DEFAULT_BANG_PREFIX &&
      settings.snapPrefix === DEFAULT_SNAP_PREFIX
        ? defaultBang
        : parsePartialBang(q, settings.bangPrefix, settings.snapPrefix);
  } else {
    const coreSettings = parseSettingsFromRawUrl(
      rawUrl,
      request,
      sp,
      false,
      bp,
      np
    );
    bang =
      coreSettings.bangPrefix === DEFAULT_BANG_PREFIX &&
      coreSettings.snapPrefix === DEFAULT_SNAP_PREFIX
        ? defaultBang
        : parsePartialBang(q, coreSettings.bangPrefix, coreSettings.snapPrefix);
    ({ settings, rewrittenSuggestCookie } = bang
      ? parseBangSettingsFromRequestWithCleanup(request, coreSettings)
      : { settings: coreSettings, rewrittenSuggestCookie: null });
  }
  const allowUnsafeCustomUrls =
    environment.ALLOW_UNSAFE_CUSTOM_SUGGEST_URLS === "true";
  return suggest(q, settings, bang, allowUnsafeCustomUrls).then((response) => {
    if (!rewrittenSuggestCookie) {
      return response;
    }

    const headers = new Headers(response.headers);
    headers.append(
      "Set-Cookie",
      `suggest=${rewrittenSuggestCookie};path=/;max-age=${COOKIE_MAX_AGE_S};SameSite=Lax;Secure`
    );
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  });
}

export function handleOpenSearchRequest(
  request: Request,
  environment: PublicOriginEnvironment = runtimeEnvironment()
): Response {
  const configuredOrigin = environment.PUBLIC_ORIGIN;
  const origin = canonicalizePublicOrigin(
    configuredOrigin ?? readOrigin(request.url)
  );
  if (!origin) {
    return new Response(
      configuredOrigin === undefined
        ? "Invalid request origin"
        : "Invalid PUBLIC_ORIGIN",
      { status: 500 }
    );
  }
  return opensearch(origin);
}
