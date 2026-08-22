import { withPathSeparator } from "../../src/shared/raw-url";
import type {
  CustomUrlParts,
  RedirectSettings,
  UrlParts,
} from "../../src/sw/redirect";
import type { RedirectSettingsSnapshot } from "../../src/sw/redirect-settings";

export const DEFAULT_REDIRECT_URL: UrlParts = [
  "https://www.google.com/search?q=",
  "",
];
export const DEFAULT_LUCKY_URL: UrlParts = [
  "https://www.google.com/search?btnI&q=",
  "",
];

export function splitUrlTemplate(rawTemplate: string): UrlParts {
  // Mirrors splitUrl() in src/sw/redirect-settings.ts, which normalizes every
  // user-supplied URL as it is compiled. Without this the fixture would build
  // prefixes production can never produce.
  const template = withPathSeparator(rawTemplate);
  const placeholder = template.indexOf("{}");
  return placeholder === -1
    ? [template, null]
    : [template.substring(0, placeholder), template.substring(placeholder + 2)];
}

export function redirectSettings({
  custom = Object.create(null) as Record<string, CustomUrlParts>,
  defaultUrl = DEFAULT_REDIRECT_URL,
  luckyUrl = DEFAULT_LUCKY_URL,
  syntax,
}: Partial<RedirectSettings> = {}): RedirectSettings {
  return {
    custom,
    defaultUrl,
    luckyUrl,
    ...(syntax ? { syntax } : {}),
  };
}

export function redirectSettingsSnapshot({
  custom = Object.create(null) as Record<string, CustomUrlParts>,
  defaultBang = "g",
  luckyProvider = "default",
  luckyUrl = null,
  syntax,
}: Partial<RedirectSettingsSnapshot> = {}): RedirectSettingsSnapshot {
  return {
    custom,
    defaultBang,
    luckyProvider,
    luckyUrl,
    ...(syntax ? { syntax } : {}),
  };
}
