import {
  DEFAULT_BANG_PREFIX,
  DEFAULT_SNAP_PREFIX,
  type TriggerPrefix,
} from "../shared/trigger-prefix";

export interface FirefoxSuggestionConfig {
  bangPrefix: TriggerPrefix;
  provider: string;
  snapPrefix: TriggerPrefix;
}

export function isFirefoxUserAgent(userAgent: string): boolean {
  const value = userAgent.toLowerCase();
  return value.includes("firefox") || value.includes("fxios");
}

export function firefoxSuggestionUrl(
  origin: string,
  { bangPrefix, provider, snapPrefix }: FirefoxSuggestionConfig
): string {
  const syntax =
    bangPrefix === DEFAULT_BANG_PREFIX && snapPrefix === DEFAULT_SNAP_PREFIX
      ? ""
      : `&bp=${encodeURIComponent(bangPrefix)}&np=${encodeURIComponent(snapPrefix)}`;
  return `${origin}/suggest?q=%s&sp=${provider}${syntax}`;
}
