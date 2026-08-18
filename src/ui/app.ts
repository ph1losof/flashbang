import { resolveTriggerPrefixes } from "../shared/trigger-prefix";
import { setSuggestCookie } from "./cookie";
import { DB, readCustomBangs } from "./db";
import { $ } from "./dom";
import { initHome } from "./home/index";
import { setupVimBlurShortcut } from "./keyboard";
import { initLiquidMetal } from "./liquid-metal";
import { setupDialog } from "./modal";
import { initSettings } from "./settings/index";
import { resolveSuggestProvider } from "./suggest-provider";

declare const __ALLOW_UNSAFE_CUSTOM_SUGGEST_URLS__: boolean;

const db = new DB();

async function syncSuggestCookie() {
  const [settings, custom] = await Promise.all([
    db.getMultipleSettings([
      "suggest-provider",
      "default-bang",
      "suggest-url",
      "bang-prefix",
      "snap-prefix",
      "content-language",
    ]),
    readCustomBangs(db),
  ]);

  const [bangPrefix, snapPrefix] = resolveTriggerPrefixes(
    settings[3],
    settings[4]
  );
  setSuggestCookie(
    resolveSuggestProvider(settings[0], __ALLOW_UNSAFE_CUSTOM_SUGGEST_URLS__),
    settings[1] || "g",
    settings[2] || "",
    custom,
    bangPrefix,
    snapPrefix,
    settings[5] || ""
  );
}

function init() {
  setupVimBlurShortcut();
  syncSuggestCookie();

  initLiquidMetal($<HTMLCanvasElement>("#metal-canvas"), "flashbang");
  const home = initHome(db);

  const { openDialog } = setupDialog({
    closeButton: $("#modal-close"),
    modal: $("#settings-modal"),
    onFirstOpen: () =>
      void initSettings(
        db,
        __ALLOW_UNSAFE_CUSTOM_SUGGEST_URLS__,
        home.refreshCatalog,
        home.setPrefixes,
        home.setFirefoxSuggestProvider
      ),
    openButton: $("#gear-btn"),
  });

  if (location.pathname === "/settings") {
    openDialog();
    history.replaceState(null, "", "/");
  }

  document.documentElement.dataset.appReady = "true";
}

init();
