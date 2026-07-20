import {
  type CaptureUrlParts,
  type CustomBangRecord,
  compileCaptureUrl,
} from "../shared/capture-template";
import {
  DEFAULT_LUCKY_URL,
  DEFAULT_URL,
  LUCKY_TRIGGER_PROVIDERS,
  LUCKY_URLS,
} from "../shared/constants";
import { hashFNV1a } from "../shared/hash";
import { idbWrap, openDB } from "../shared/idb";
import { compileSnapTarget, type SnapTargetParts } from "../shared/snap-target";
import { resolveTriggerPrefixes } from "../shared/trigger-prefix";
import { lookupBang } from "./bang-data";
import {
  type CustomUrlParts,
  compileTriggerSyntax,
  type RedirectSettings,
  type UrlParts,
} from "./redirect";

function splitUrl(url: string): UrlParts {
  const idx = url.indexOf("{}");
  return idx === -1
    ? [url, null]
    : [url.substring(0, idx), url.substring(idx + 2)];
}

function attachSnapTarget(
  entry: UrlParts | CaptureUrlParts,
  snap: SnapTargetParts | null
): CustomUrlParts {
  return snap ? ([...entry, snap] as CustomUrlParts) : entry;
}

export function defaultRedirectSettings(): RedirectSettings {
  return {
    defaultUrl: splitUrl(DEFAULT_URL),
    custom: Object.create(null),
    luckyUrl: splitUrl(DEFAULT_LUCKY_URL),
  };
}

export async function loadRedirectSettings(): Promise<{
  frecency: string | undefined;
  settings: RedirectSettings;
}> {
  const db = await openDB();
  const tx = db.transaction(["settings", "custom-bangs"], "readonly");
  const [settings, all] = await Promise.all([
    idbWrap<Array<{ key: string; value?: string }>>(
      tx.objectStore("settings").getAll()
    ),
    idbWrap<CustomBangRecord[]>(tx.objectStore("custom-bangs").getAll()),
  ]);
  const settingsMap = Object.fromEntries(
    settings.map((setting) => [setting.key, setting.value])
  );
  const defaultBang = settingsMap["default-bang"] || "g";
  const custom: Record<string, CustomUrlParts> = Object.create(null);
  for (const entry of all) {
    const snap = entry.snap ? compileSnapTarget(entry.snap) : null;
    if (entry.regex) {
      const advanced = compileCaptureUrl(
        entry.url,
        entry.regex,
        entry.encoding
      );
      if (advanced) {
        custom[entry.trigger] = attachSnapTarget(advanced, snap);
      }
    } else {
      custom[entry.trigger] = attachSnapTarget(splitUrl(entry.url), snap);
    }
  }

  const customDefault = custom[defaultBang];
  let defaultEntry: UrlParts | null;
  if (customDefault) {
    defaultEntry =
      customDefault.length < 5 ? (customDefault as UrlParts) : null;
  } else {
    defaultEntry = lookupBang(defaultBang, hashFNV1a(defaultBang));
  }
  const defaultUrl = defaultEntry || splitUrl(DEFAULT_URL);
  const effectiveDefaultBang = defaultEntry ? defaultBang : "g";
  const [bangPrefix, snapPrefix] = resolveTriggerPrefixes(
    settingsMap["bang-prefix"],
    settingsMap["snap-prefix"]
  );

  const luckyProvider = settingsMap["lucky-provider"] ?? "default";
  let luckyUrl: UrlParts | null;
  switch (luckyProvider) {
    case "none":
      luckyUrl = null;
      break;
    case "google":
      luckyUrl = splitUrl(LUCKY_URLS.google);
      break;
    case "ddg":
      luckyUrl = splitUrl(LUCKY_URLS.ddg);
      break;
    case "kagi":
      luckyUrl = splitUrl(LUCKY_URLS.kagi);
      break;
    case "custom":
      luckyUrl = settingsMap["lucky-url"]
        ? splitUrl(settingsMap["lucky-url"])
        : null;
      break;
    default:
      luckyUrl = splitUrl(
        LUCKY_URLS[LUCKY_TRIGGER_PROVIDERS[effectiveDefaultBang]] ||
          DEFAULT_LUCKY_URL
      );
      break;
  }

  const syntax = compileTriggerSyntax(bangPrefix, snapPrefix);
  return {
    frecency: settingsMap.frecency,
    settings: {
      defaultUrl,
      custom,
      luckyUrl,
      ...(syntax ? { syntax } : {}),
    },
  };
}
