import { COOKIE_MAX_AGE_S } from "../shared/constants";
import { encodeSuggestCookieValue } from "../shared/suggest-cookie";
import {
  DEFAULT_BANG_PREFIX,
  DEFAULT_SNAP_PREFIX,
  type TriggerPrefix,
} from "../shared/trigger-prefix";

export function setSuggestCookie(
  provider: string,
  trigger: string,
  customUrl: string,
  custom?: string[],
  bangPrefix: TriggerPrefix = DEFAULT_BANG_PREFIX,
  snapPrefix: TriggerPrefix = DEFAULT_SNAP_PREFIX,
  contentLanguage = ""
) {
  const value = encodeSuggestCookieValue(
    provider,
    trigger,
    customUrl,
    custom,
    null,
    bangPrefix,
    snapPrefix,
    contentLanguage || null
  );
  document.cookie = `suggest=${value};path=/;max-age=${COOKIE_MAX_AGE_S};SameSite=Lax;Secure`;
}
