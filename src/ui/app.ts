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
    db.getMultipleSettings(["suggest-provider", "default-bang", "suggest-url"]),
    readCustomBangs(db),
  ]);

  setSuggestCookie(
    resolveSuggestProvider(settings[0], __ALLOW_UNSAFE_CUSTOM_SUGGEST_URLS__),
    settings[1] || "g",
    settings[2] || "",
    custom
  );
}

function init() {
  setupVimBlurShortcut();
  syncSuggestCookie();

  initLiquidMetal($<HTMLCanvasElement>("#metal-canvas"), "flashbang");
  const refreshHomeCatalog = initHome(db);

  const { openDialog } = setupDialog({
    closeButton: $("#modal-close"),
    modal: $("#settings-modal"),
    onFirstOpen: () =>
      void initSettings(
        db,
        __ALLOW_UNSAFE_CUSTOM_SUGGEST_URLS__,
        refreshHomeCatalog
      ),
    openButton: $("#gear-btn"),
  });

  if (location.pathname === "/settings") {
    openDialog();
    history.replaceState(null, "", "/");
  }
}

init();
