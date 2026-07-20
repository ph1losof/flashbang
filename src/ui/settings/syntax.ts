import {
  TRIGGER_PREFIXES,
  type TriggerPrefix,
} from "../../shared/trigger-prefix";
import type { DB } from "../db";
import { $ } from "../dom";
import { notifySW } from "../sw-bridge";
import type { SettingsWriter } from "./write";

export interface SyntaxSettingsState {
  bangPrefix: TriggerPrefix;
  snapPrefix: TriggerPrefix;
}

interface SyntaxSettingsOptions {
  db: DB;
  onChange: () => void;
  state: SyntaxSettingsState;
  writer: SettingsWriter;
}

export interface SyntaxSettingsController {
  bangSelect: HTMLSelectElement;
  refresh: () => void;
  snapSelect: HTMLSelectElement;
}

function setOptions(select: HTMLSelectElement): void {
  select.replaceChildren(
    ...TRIGGER_PREFIXES.map((prefix) => {
      const option = document.createElement("option");
      option.value = prefix;
      option.textContent = prefix;
      return option;
    })
  );
}

export function setupSyntaxSettings({
  db,
  onChange,
  state,
  writer,
}: SyntaxSettingsOptions): SyntaxSettingsController {
  const bangSelect = $<HTMLSelectElement>("#bang-prefix");
  const snapSelect = $<HTMLSelectElement>("#snap-prefix");
  const defaultPrefix = $("#default-bang-prefix");
  const luckyLeading = $("#lucky-leading-syntax");
  const luckyTrailing = $("#lucky-trailing-syntax");
  setOptions(bangSelect);
  setOptions(snapSelect);

  function refresh(): void {
    bangSelect.value = state.bangPrefix;
    snapSelect.value = state.snapPrefix;
    for (const option of bangSelect.options) {
      option.disabled = option.value === state.snapPrefix;
    }
    for (const option of snapSelect.options) {
      option.disabled = option.value === state.bangPrefix;
    }
    defaultPrefix.textContent = state.bangPrefix;
    luckyLeading.textContent = `${state.bangPrefix} query`;
    luckyTrailing.textContent = `query ${state.bangPrefix}`;
  }

  function bind(
    select: HTMLSelectElement,
    key: "bang-prefix" | "snap-prefix",
    stateKey: "bangPrefix" | "snapPrefix",
    otherKey: "bangPrefix" | "snapPrefix"
  ): void {
    select.addEventListener("change", () => {
      const value = select.value as TriggerPrefix;
      if (!TRIGGER_PREFIXES.includes(value) || value === state[otherKey]) {
        select.value = state[stateKey];
        return;
      }
      void writer.run(() => db.setSetting(key, value), {
        key,
        onCommit: () => {
          state[stateKey] = value;
          refresh();
          notifySW("invalidate");
          onChange();
        },
        onFailure: refresh,
      });
    });
  }

  bind(bangSelect, "bang-prefix", "bangPrefix", "snapPrefix");
  bind(snapSelect, "snap-prefix", "snapPrefix", "bangPrefix");
  refresh();
  return { bangSelect, refresh, snapSelect };
}
