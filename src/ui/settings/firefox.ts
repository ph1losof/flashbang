import type { TriggerPrefix } from "../../shared/trigger-prefix";
import { flashAnim } from "../animations";
import { copyText } from "../clipboard";
import { $, el } from "../dom";
import { firefoxSuggestionUrl } from "../firefox-suggest";
import type { SettingsWriter } from "./write";

interface FirefoxSuggestionControls {
  getContentLanguage: () => string;
  getPrefixes: () => readonly [TriggerPrefix, TriggerPrefix];
  onProviderChange: (provider: string) => void;
  suggestSelect: HTMLSelectElement;
  suggestUrlInput: HTMLInputElement;
}

export function setupFirefoxSuggestions(
  {
    getContentLanguage,
    getPrefixes,
    onProviderChange,
    suggestSelect,
    suggestUrlInput,
  }: FirefoxSuggestionControls,
  writer: SettingsWriter
): { refresh: () => void } {
  const note = $("#suggest-firefox-note");
  const pickerWrap = $("#suggest-firefox-provider-picker-wrap");
  const picker = $<HTMLButtonElement>("#suggest-firefox-provider-picker");
  const label = $("#suggest-firefox-provider-label");
  const url = $<HTMLButtonElement>("#suggest-firefox-url");
  const menu = $("#suggest-firefox-provider-menu");
  let provider = "google";
  let menuHideTimer: ReturnType<typeof setTimeout>;
  let menuPinned = false;

  const suggestionUrl = () => {
    const [bangPrefix, snapPrefix] = getPrefixes();
    return firefoxSuggestionUrl(location.origin, {
      bangPrefix,
      contentLanguage: getContentLanguage(),
      provider,
      snapPrefix,
    });
  };
  const showMenu = () => {
    clearTimeout(menuHideTimer);
    menu.classList.remove("hidden");
    picker.setAttribute("aria-expanded", "true");
  };
  const hideMenu = () => {
    menu.classList.add("hidden");
    picker.setAttribute("aria-expanded", "false");
  };
  const renderUrl = () => {
    const providerToken = el(
      "span",
      "rounded bg-success px-1 py-0.5 text-bg",
      provider
    );
    label.textContent = provider;
    const value = suggestionUrl();
    const providerStart = `${location.origin}/suggest?q=%s&sp=`.length;
    url.replaceChildren(
      value.substring(0, providerStart),
      providerToken,
      value.substring(providerStart + provider.length)
    );
    for (const option of menu.children) {
      const selected = (option as HTMLElement).dataset.provider === provider;
      option.setAttribute("aria-selected", String(selected));
      option.classList.toggle("bg-bg-active", selected);
    }
  };

  const providerOptions = Array.from(suggestSelect.options).filter(
    (option) => !["default", "custom", "none"].includes(option.value)
  );
  menu.replaceChildren(
    ...providerOptions.map((option) => {
      const button = el(
        "button",
        "block w-full rounded-md border-none bg-transparent px-2.5 py-1.5 text-left text-xs text-text cursor-pointer hover:bg-bg-hover",
        option.text
      );
      button.type = "button";
      button.dataset.provider = option.value;
      button.setAttribute("role", "option");
      button.addEventListener("click", () => {
        provider = option.value;
        onProviderChange(provider);
        menuPinned = false;
        renderUrl();
        hideMenu();
        picker.focus();
      });
      button.addEventListener("focus", showMenu);
      return button;
    })
  );

  suggestSelect.value = "google";
  suggestSelect.classList.add("select-locked");
  suggestSelect.setAttribute("aria-describedby", "suggest-firefox-note");
  note.classList.remove("hidden");
  writer.lock(suggestSelect);
  writer.lock(suggestUrlInput);
  onProviderChange(provider);
  renderUrl();

  pickerWrap.addEventListener("pointerenter", () => {
    if (!menuPinned) {
      showMenu();
    }
  });
  pickerWrap.addEventListener("pointerleave", () => {
    if (!menuPinned) {
      menuHideTimer = setTimeout(hideMenu, 150);
    }
  });
  picker.addEventListener("click", () => {
    menuPinned = !menuPinned;
    if (menuPinned) {
      showMenu();
    } else {
      hideMenu();
    }
  });
  picker.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      menuPinned = true;
      showMenu();
      (menu.firstElementChild as HTMLElement)?.focus();
    }
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      menuPinned = false;
      hideMenu();
      picker.focus();
    }
  });
  document.addEventListener("click", (event) => {
    if (
      menuPinned &&
      event.target instanceof Node &&
      !pickerWrap.contains(event.target)
    ) {
      menuPinned = false;
      hideMenu();
    }
  });
  url.addEventListener("click", async () => {
    const value = suggestionUrl();
    hideMenu();
    try {
      await copyText(value);
      url.textContent = "Copied suggestion URL";
      flashAnim(url);
    } catch {
      url.textContent = "Could not copy suggestion URL";
    }
    setTimeout(renderUrl, 1500);
  });
  return { refresh: renderUrl };
}
