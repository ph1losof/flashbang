import {
  DEFAULT_BANG_PREFIX,
  DEFAULT_SNAP_PREFIX,
  type TriggerPrefix,
} from "../shared/trigger-prefix";

export interface FirefoxSuggestionConfig {
  bangPrefix: TriggerPrefix;
  contentLanguage?: string;
  provider: string;
  snapPrefix: TriggerPrefix;
}

export function isFirefoxUserAgent(userAgent: string): boolean {
  const value = userAgent.toLowerCase();
  return value.includes("firefox") || value.includes("fxios");
}

export function firefoxSuggestionUrl(
  origin: string,
  { bangPrefix, contentLanguage, provider, snapPrefix }: FirefoxSuggestionConfig
): string {
  const syntax =
    bangPrefix === DEFAULT_BANG_PREFIX && snapPrefix === DEFAULT_SNAP_PREFIX
      ? ""
      : `&bp=${encodeURIComponent(bangPrefix)}&np=${encodeURIComponent(snapPrefix)}`;
  const lang = contentLanguage
    ? `&lang=${encodeURIComponent(contentLanguage)}`
    : "";
  return `${origin}/suggest?q=%s&sp=${provider}${syntax}${lang}&site_specific_forward=1`;
}
