import { LOCALE_DISABLED, LOCALE_PATTERNS } from "../../shared/locale-table";
import type { DB } from "../db";
import { $ } from "../dom";
import type { SettingsWriter } from "./write";

export interface LocaleSettingsState {
  contentLanguage: string;
}

interface LocaleSettingsOptions {
  db: DB;
  onChange: () => void;
  state: LocaleSettingsState;
  writer: SettingsWriter;
}

export interface LocaleSettingsController {
  refresh: () => void;
  select: HTMLSelectElement;
}

function languageChoices(): string[] {
  const codes = new Set<string>();
  for (const pattern of LOCALE_PATTERNS) {
    for (const code of pattern.supported.split(" ")) {
      codes.add(code);
    }
  }
  return [...codes].sort();
}

function labelFor(code: string): string {
  try {
    const display = new Intl.DisplayNames([code], { type: "language" }).of(
      code
    );
    return display && display !== code ? `${display} (${code})` : code;
  } catch {
    return code;
  }
}

export function setupLocaleSettings({
  db,
  onChange,
  state,
  writer,
}: LocaleSettingsOptions): LocaleSettingsController {
  const select = $<HTMLSelectElement>("#content-language");
  const browserOption = document.createElement("option");
  browserOption.value = "";
  browserOption.textContent = "Follow browser";
  const offOption = document.createElement("option");
  offOption.value = LOCALE_DISABLED;
  offOption.textContent = "Off \u2014 use each site's default";
  select.replaceChildren(
    browserOption,
    offOption,
    ...languageChoices().map((code) => {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = labelFor(code);
      return option;
    })
  );

  function refresh(): void {
    select.value = state.contentLanguage;
    if (select.value !== state.contentLanguage) {
      select.value = "";
    }
  }

  select.addEventListener("change", () => {
    const value = select.value;
    void writer.run(() => db.setSetting("content-language", value), {
      key: "content-language",
      onCommit: () => {
        state.contentLanguage = value;
        refresh();
        onChange();
      },
      onFailure: refresh,
    });
  });

  refresh();
  return { refresh, select };
}
