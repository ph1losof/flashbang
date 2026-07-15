import { setSuggestCookie } from "../cookie";
import type { DB } from "../db";
import { $ } from "../dom";
import { resolveSuggestProvider } from "../suggest-provider";
import { notifySW } from "../sw-bridge";
import { setupCustomBangs } from "./custom-bangs";
import { setupDefaultBangSetting } from "./default-bang";
import { getProviderControls, setupProviderSettings } from "./providers";
import { setupSettingsTransfer } from "./transfer";
import { createSettingsWriter, type SettingControl } from "./write";

const SETTINGS_KEYS = [
  "default-bang",
  "suggest-provider",
  "suggest-url",
  "lucky-provider",
  "lucky-url",
];

export async function initSettings(
  db: DB,
  allowUnsafeCustomSuggestUrls = false,
  onCatalogChange?: () => void
): Promise<void> {
  const defaultInput = $<HTMLInputElement>("#default-bang");
  const importFile = $<HTMLInputElement>("#import-file");
  const exportButton = $<HTMLButtonElement>("#export-btn");
  const providerControls = getProviderControls();
  const [rawSettings, initialCustom] = await Promise.all([
    db.getMultipleSettings(SETTINGS_KEYS),
    db.getAllCustomBangs(),
  ]);
  const state = {
    custom: initialCustom.map((bang) => bang.trigger),
    defaultBang: rawSettings[0] || "g",
    suggestProvider: resolveSuggestProvider(
      rawSettings[1],
      allowUnsafeCustomSuggestUrls
    ),
    suggestUrl: rawSettings[2] || "",
    luckyProvider: rawSettings[3] || "default",
    luckyUrl: rawSettings[4] || "",
  };

  const customFormControls = Array.from(
    $<HTMLFormElement>("#add-bang-form").elements
  ).filter(
    (control): control is SettingControl =>
      control instanceof HTMLInputElement ||
      control instanceof HTMLSelectElement ||
      control instanceof HTMLButtonElement
  );
  const writer = createSettingsWriter([
    defaultInput,
    providerControls.suggestSelect,
    providerControls.suggestUrlInput,
    providerControls.luckySelect,
    providerControls.luckyUrlInput,
    importFile,
    exportButton,
    ...customFormControls,
  ]);

  const syncCookie = () => {
    setSuggestCookie(
      state.suggestProvider,
      state.defaultBang,
      state.suggestUrl,
      state.custom
    );
  };
  const providers = setupProviderSettings({
    controls: providerControls,
    db,
    onSuggestChange: syncCookie,
    state,
    writer,
  });
  syncCookie();

  const defaultBang = await setupDefaultBangSetting({
    db,
    initialBang: state.defaultBang,
    initialCustom,
    onCommit: (trigger) => {
      state.defaultBang = trigger;
      syncCookie();
      providers.updateDefaultDisplays();
    },
    runWrite: writer.run,
  });
  state.defaultBang = defaultBang.setCommitted(state.defaultBang);
  syncCookie();
  providers.updateDefaultDisplays();
  const refreshCustomBangs = setupCustomBangs(
    db,
    (custom) => {
      state.custom = custom.map((bang) => bang.trigger);
      state.defaultBang = defaultBang.setCustomBangs(custom);
      syncCookie();
      onCatalogChange?.();
    },
    writer.run
  );

  setupSettingsTransfer({
    db,
    exportButton,
    importFile,
    onImported: async () => {
      const imported = await db.getMultipleSettings(SETTINGS_KEYS);
      const importedDefaultBang = imported[0] || "g";
      state.defaultBang = importedDefaultBang;
      state.suggestProvider = providers.isFirefox
        ? "google"
        : resolveSuggestProvider(imported[1], allowUnsafeCustomSuggestUrls);
      state.suggestUrl = imported[2] || "";
      state.luckyProvider = imported[3] || "default";
      state.luckyUrl = imported[4] || "";
      await refreshCustomBangs();
      state.defaultBang = defaultBang.setCommitted(importedDefaultBang);
      providers.refresh();
      writer.clearErrors();
      syncCookie();
      notifySW("invalidate");
    },
    runWrite: writer.run,
  });
}
