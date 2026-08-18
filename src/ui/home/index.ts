import {
  DEFAULT_BANG_PREFIX,
  DEFAULT_SNAP_PREFIX,
  resolveTriggerPrefixes,
  type TriggerPrefix,
} from "../../shared/trigger-prefix";
import type { DB } from "../db";
import { setupAddressBarSheet } from "./address-bar-setup";
import { setupBangCommand } from "./command";
import { setupHomeShortcuts } from "./shortcuts";

export interface HomeController {
  refreshCatalog: () => Promise<void>;
  setFirefoxSuggestProvider: (provider: string) => void;
  setPrefixes: (bang: TriggerPrefix, snap: TriggerPrefix) => void;
}

export function initHome(db: DB): HomeController {
  const {
    input,
    refresh,
    setPrefixes: setCommandPrefixes,
  } = setupBangCommand(db);
  let bangPrefix = DEFAULT_BANG_PREFIX;
  let snapPrefix = DEFAULT_SNAP_PREFIX;
  let firefoxSuggestProvider = "google";
  let contentLanguage = "";
  const addressBar = setupAddressBarSheet(() => ({
    bangPrefix,
    contentLanguage,
    provider: firefoxSuggestProvider,
    snapPrefix,
  }));
  const setPrefixes = (bang: TriggerPrefix, snap: TriggerPrefix) => {
    bangPrefix = bang;
    snapPrefix = snap;
    setCommandPrefixes(bang, snap);
    addressBar.refreshSuggestionUrl();
  };
  const setFirefoxSuggestProvider = (provider: string) => {
    firefoxSuggestProvider = provider;
    addressBar.refreshSuggestionUrl();
  };
  setupHomeShortcuts(input, () => [bangPrefix, snapPrefix]);
  void db
    .getMultipleSettings(["bang-prefix", "snap-prefix", "content-language"])
    .then((values) => {
      const [bang, snap] = resolveTriggerPrefixes(values[0], values[1]);
      contentLanguage = values[2] || "";
      setPrefixes(bang, snap);
    });
  return { refreshCatalog: refresh, setFirefoxSuggestProvider, setPrefixes };
}
