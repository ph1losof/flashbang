import { validateSimpleBangUrl } from "../../shared/capture-template";
import {
  DEFAULT_LUCKY_PROVIDER,
  LUCKY_TRIGGER_PROVIDERS,
  SUGGEST_TRIGGER_PROVIDERS,
} from "../../shared/constants";
import type { DB } from "../db";
import { $ } from "../dom";
import { isFirefoxUserAgent } from "../firefox-suggest";
import { setupFirefoxSuggestions } from "./firefox";
import type { SettingsWriter } from "./write";

export interface ProviderControls {
  luckySelect: HTMLSelectElement;
  luckyUrlInput: HTMLInputElement;
  suggestSelect: HTMLSelectElement;
  suggestUrlInput: HTMLInputElement;
}

export interface ProviderSettingsState {
  bangPrefix: import("../../shared/trigger-prefix").TriggerPrefix;
  contentLanguage: string;
  defaultBang: string;
  luckyProvider: string;
  luckyUrl: string;
  snapPrefix: import("../../shared/trigger-prefix").TriggerPrefix;
  suggestProvider: string;
  suggestUrl: string;
}

interface ProviderSettingsOptions {
  controls: ProviderControls;
  db: DB;
  onFirefoxSuggestProviderChange: (provider: string) => void;
  onSuggestChange: () => void;
  state: ProviderSettingsState;
  writer: SettingsWriter;
}

export interface ProviderSettingsController {
  isFirefox: boolean;
  refresh: () => void;
  updateDefaultDisplays: () => void;
}

export function getProviderControls(): ProviderControls {
  return {
    luckySelect: $<HTMLSelectElement>("#lucky-provider"),
    luckyUrlInput: $<HTMLInputElement>("#lucky-url"),
    suggestSelect: $<HTMLSelectElement>("#suggest-provider"),
    suggestUrlInput: $<HTMLInputElement>("#suggest-url"),
  };
}

function setDefaultDisplay(
  select: HTMLSelectElement,
  display: HTMLElement,
  prefix: HTMLElement,
  providerBadge: HTMLElement,
  matchedProvider: string | undefined,
  fallbackProvider: string
): void {
  const provider = matchedProvider || fallbackProvider;
  const providerOption = Array.from(select.options).find(
    (option) => option.value === provider
  );
  prefix.textContent = matchedProvider ? "Match bang" : "Fallback";
  providerBadge.textContent = providerOption?.text || provider;
  const visible = select.value === "default";
  display.classList.toggle("hidden", !visible);
  display.classList.toggle("flex", visible);
}

interface ProviderControlOptions {
  db: DB;
  onChange: () => void;
  onProviderSettled: () => void;
  select: HTMLSelectElement;
  setting: "lucky" | "suggest";
  state: ProviderSettingsState;
  urlInput: HTMLInputElement;
  writer: SettingsWriter;
}

function setupProviderControl({
  db,
  onChange,
  onProviderSettled,
  select,
  setting,
  state,
  urlInput,
  writer,
}: ProviderControlOptions): { refresh: (syncSelect?: boolean) => void } {
  const providerKey = `${setting}-provider`;
  const urlKey = `${setting}-url`;
  const providerStateKey =
    setting === "suggest" ? "suggestProvider" : "luckyProvider";
  const urlStateKey = setting === "suggest" ? "suggestUrl" : "luckyUrl";
  const label = setting === "suggest" ? "suggestion" : "lucky";
  let pendingCustom = false;

  function refresh(syncSelect = true): void {
    urlInput.value = state[urlStateKey];
    urlInput.removeAttribute("aria-invalid");
    if (syncSelect) {
      select.value = state[providerStateKey];
      urlInput.classList.toggle("hidden", state[providerStateKey] !== "custom");
    }
    pendingCustom = false;
  }

  select.addEventListener("change", () => {
    const value = select.value;
    if (value === "custom") {
      urlInput.classList.remove("hidden");
      const error = validateSimpleBangUrl(state[urlStateKey]);
      if (error) {
        pendingCustom = true;
        select.value = state[providerStateKey];
        writer.showValidationError(
          urlKey,
          `Custom ${label} URL: ${error}`,
          urlInput
        );
        urlInput.focus();
        return;
      }
      pendingCustom = false;
    } else {
      pendingCustom = false;
      urlInput.classList.add("hidden");
    }
    writer.clearValidationError(urlKey, urlInput);
    void writer.run(() => db.setSetting(providerKey, value), {
      key: providerKey,
      onCommit: () => {
        state[providerStateKey] = value;
        onChange();
        onProviderSettled();
      },
      onFailure: () => {
        select.value = state[providerStateKey];
        urlInput.classList.toggle(
          "hidden",
          state[providerStateKey] !== "custom"
        );
        onProviderSettled();
      },
    });
  });

  urlInput.addEventListener("change", () => {
    const value = urlInput.value.trim();
    let error = value ? validateSimpleBangUrl(value) : null;
    if (!value && state[providerStateKey] === "custom") {
      error = "URL must contain {} for the query";
    }
    if (error) {
      writer.showValidationError(
        urlKey,
        `Invalid ${label} URL: ${error}`,
        urlInput
      );
      return;
    }
    writer.clearValidationError(urlKey, urlInput);
    void writer.run(() => db.setSetting(urlKey, value), {
      key: urlKey,
      onCommit: () => {
        state[urlStateKey] = value;
        onChange();
        if (pendingCustom) {
          pendingCustom = false;
          select.value = "custom";
          select.dispatchEvent(new Event("change"));
        }
      },
      onFailure: () => {
        urlInput.value = state[urlStateKey];
      },
    });
  });

  return { refresh };
}

export function setupProviderSettings({
  controls,
  db,
  onFirefoxSuggestProviderChange,
  onSuggestChange,
  state,
  writer,
}: ProviderSettingsOptions): ProviderSettingsController {
  const { luckySelect, luckyUrlInput, suggestSelect, suggestUrlInput } =
    controls;
  const luckyDefaultDisplay = $("#lucky-default-display");
  const luckyDefaultPrefix = $("#lucky-default-prefix");
  const luckyDefaultProvider = $("#lucky-default-provider");
  const suggestDefaultDisplay = $("#suggest-default-display");
  const suggestDefaultPrefix = $("#suggest-default-prefix");
  const suggestDefaultProvider = $("#suggest-default-provider");
  const isFirefox = isFirefoxUserAgent(navigator.userAgent);
  let refreshFirefoxSuggestions: (() => void) | null = null;

  function updateDefaultDisplays(): void {
    setDefaultDisplay(
      luckySelect,
      luckyDefaultDisplay,
      luckyDefaultPrefix,
      luckyDefaultProvider,
      LUCKY_TRIGGER_PROVIDERS[state.defaultBang],
      DEFAULT_LUCKY_PROVIDER
    );
    setDefaultDisplay(
      suggestSelect,
      suggestDefaultDisplay,
      suggestDefaultPrefix,
      suggestDefaultProvider,
      SUGGEST_TRIGGER_PROVIDERS[state.defaultBang],
      "none"
    );
  }

  const suggestControl = setupProviderControl({
    db,
    onChange: onSuggestChange,
    onProviderSettled: updateDefaultDisplays,
    select: suggestSelect,
    setting: "suggest",
    state,
    urlInput: suggestUrlInput,
    writer,
  });
  const luckyControl = setupProviderControl({
    db,
    onChange: () => undefined,
    onProviderSettled: updateDefaultDisplays,
    select: luckySelect,
    setting: "lucky",
    state,
    urlInput: luckyUrlInput,
    writer,
  });

  function refresh(): void {
    suggestControl.refresh(!isFirefox);
    luckyControl.refresh();
    updateDefaultDisplays();
    refreshFirefoxSuggestions?.();
  }

  if (isFirefox) {
    state.suggestProvider = "google";
    refreshFirefoxSuggestions = setupFirefoxSuggestions(
      {
        ...controls,
        getPrefixes: () => [state.bangPrefix, state.snapPrefix],
        getContentLanguage: () => state.contentLanguage,
        onProviderChange: onFirefoxSuggestProviderChange,
      },
      writer
    ).refresh;
  }
  refresh();

  return { isFirefox, refresh, updateDefaultDisplays };
}
