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
  allowUnsafeCustomSuggestUrls = false
): Promise<void> {
  const defaultInput = $<HTMLInputElement>("#default-bang");
  const importFile = $<HTMLInputElement>("#import-file");
  const exportButton = $<HTMLButtonElement>("#export-btn");
  const providerControls = getProviderControls();
  const [rawSettings, initialCustom] = await Promise.all([
    db.getMultipleSettings(SETTINGS_KEYS),
    db.getAllCustomBangs().then((all) => all.map((bang) => bang.trigger)),
  ]);
  const state = {
    custom: initialCustom,
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
    onCommit: (trigger) => {
      state.defaultBang = trigger;
      syncCookie();
      providers.updateDefaultDisplays();
    },
    runWrite: writer.run,
  });
  const refreshCustomBangs = setupCustomBangs(
    db,
    (custom) => {
      state.custom = custom;
      syncCookie();
    },
    writer.run
  );

  setupSettingsTransfer({
    db,
    exportButton,
    importFile,
    onImported: async () => {
      const imported = await db.getMultipleSettings(SETTINGS_KEYS);
      state.defaultBang = imported[0] || "g";
      state.suggestProvider = providers.isFirefox
        ? "google"
        : resolveSuggestProvider(imported[1], allowUnsafeCustomSuggestUrls);
      state.suggestUrl = imported[2] || "";
      state.luckyProvider = imported[3] || "default";
      state.luckyUrl = imported[4] || "";
      defaultBang.setCommitted(state.defaultBang);
      providers.refresh();
      writer.clearErrors();
      await refreshCustomBangs();
      syncCookie();
      notifySW("invalidate");
    },
    runWrite: writer.run,
  });
}
