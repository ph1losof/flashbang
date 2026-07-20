import { parsePartialSnapChain } from "../../shared/snap-chain";
import {
  DEFAULT_BANG_PREFIX,
  DEFAULT_SNAP_PREFIX,
  type TriggerPrefix,
} from "../../shared/trigger-prefix";
import {
  type BangMeta,
  createBangMeta,
  loadBuiltinBangCatalog,
  searchBangs,
} from "../bang-catalog";
import type { DB } from "../db";
import { $, el } from "../dom";

function customDomain(url: string): string {
  try {
    return new URL(url.replace("{}", "query")).hostname || "custom";
  } catch {
    return "custom";
  }
}

export interface BangCommandController {
  input: HTMLInputElement;
  refresh: () => Promise<void>;
  setPrefixes: (bang: TriggerPrefix, snap: TriggerPrefix) => void;
}

export function setupBangCommand(db: DB): BangCommandController {
  const form = $<HTMLFormElement>("#bang-command-form");
  const input = $<HTMLInputElement>("#bang-command-input");
  const selectedBadge = $<HTMLButtonElement>("#bang-command-selected");
  const selectedBadgeText = $("#bang-command-selected-text");
  const results = $("#bang-command-results");
  const count = $("#home-bang-count");
  let bangPrefix = DEFAULT_BANG_PREFIX;
  let snapPrefix = DEFAULT_SNAP_PREFIX;
  let defaultPlaceholder = input.placeholder;
  let entries: readonly BangMeta[] | null = null;
  let loading: Promise<void> | null = null;
  let visible: BangMeta[] = [];
  let optionElements: HTMLButtonElement[] = [];
  let selectedCommand: { marker: TriggerPrefix; trigger: string } | null = null;
  let selected = -1;
  let catalogVersion = 0;

  function closeResults(): void {
    results.classList.add("hidden");
    results.replaceChildren();
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    visible = [];
    optionElements = [];
    selected = -1;
  }

  function commandParts(): {
    chainPrefix?: string;
    marker: TriggerPrefix;
    search: string;
    selectedTriggers?: readonly string[];
    terms: string;
  } | null {
    function parts(
      marker: TriggerPrefix,
      search: string,
      terms: string
    ): {
      chainPrefix?: string;
      marker: TriggerPrefix;
      search: string;
      selectedTriggers?: readonly string[];
      terms: string;
    } | null {
      if (marker === snapPrefix && search.includes(",")) {
        const chain = parsePartialSnapChain(search);
        return chain
          ? {
              marker,
              search: chain.partial,
              terms,
              chainPrefix: chain.chainPrefix,
              selectedTriggers: chain.selectedTriggers,
            }
          : null;
      }
      return { marker, search: search.toLowerCase(), terms };
    }

    const value = input.value.trimStart();
    if (!value) {
      return null;
    }
    const leadingMarker = value.charAt(0);
    if (leadingMarker === bangPrefix || leadingMarker === snapPrefix) {
      const search = value.substring(1);
      return /\s/.test(search) ? null : parts(leadingMarker, search, "");
    }

    const bangIndex = value.lastIndexOf(` ${bangPrefix}`);
    const snapIndex = value.lastIndexOf(` ${snapPrefix}`);
    const markerIndex = Math.max(bangIndex, snapIndex);
    if (markerIndex !== -1) {
      const marker = value.charAt(markerIndex + 1) as TriggerPrefix;
      const search = value.substring(markerIndex + 2);
      return /\s/.test(search)
        ? null
        : parts(marker, search, value.substring(0, markerIndex).trim());
    }

    const search = value.toLowerCase().trim();
    return /\s/.test(search) ? null : { marker: bangPrefix, search, terms: "" };
  }

  function renderSelection(previous = -1, scroll = true): void {
    const previousOption = optionElements[previous];
    if (previousOption) {
      previousOption.classList.remove("command-result-active");
      previousOption.setAttribute("aria-selected", "false");
    }
    const option = optionElements[selected];
    if (option) {
      option.classList.add("command-result-active");
      option.setAttribute("aria-selected", "true");
      input.setAttribute("aria-activedescendant", option.id);
      if (scroll) {
        option.scrollIntoView({ block: "nearest" });
      }
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function setSelection(next: number): void {
    if (next === selected) {
      return;
    }
    const previous = selected;
    selected = next;
    renderSelection(previous);
  }

  function select(
    entry: BangMeta,
    marker: TriggerPrefix,
    terms: string,
    trigger = entry.trigger
  ): void {
    selectedCommand = { marker, trigger };
    selectedBadgeText.textContent = `${marker}${trigger}`;
    let kind = "bang";
    if (marker === snapPrefix) {
      kind = trigger.includes(",") ? "snap chain" : "snap";
    }
    selectedBadge.setAttribute(
      "aria-label",
      `Remove ${marker}${trigger} ${kind}`
    );
    selectedBadge.title = `Remove ${marker}${trigger}`;
    selectedBadge.classList.remove("hidden");
    selectedBadge.classList.add("flex");
    input.style.paddingLeft = `${selectedBadge.offsetWidth + 16}px`;
    input.value = terms;
    input.placeholder =
      kind === "snap chain"
        ? "Search this snap chain"
        : `Search with ${entry.name}`;
    closeResults();
    input.focus();
  }

  function clearSelectedCommand(showResults = false): void {
    selectedCommand = null;
    selectedBadge.classList.add("hidden");
    selectedBadge.classList.remove("flex");
    selectedBadgeText.textContent = "";
    selectedBadge.removeAttribute("aria-label");
    selectedBadge.removeAttribute("title");
    input.style.removeProperty("padding-left");
    input.placeholder = defaultPlaceholder;
    input.focus();
    if (showResults && entries && input.value.trim()) {
      renderResults();
    }
  }

  function renderResults(): void {
    if (!entries) {
      return;
    }
    const parts = commandParts();
    if (!parts) {
      closeResults();
      return;
    }
    const resultLimit = 7 + (parts.selectedTriggers?.length ?? 0);
    const matches = parts.search
      ? searchBangs(entries, parts.search, resultLimit)
      : entries.slice(0, resultLimit);
    visible = parts.selectedTriggers
      ? matches
          .filter((entry) => !parts.selectedTriggers?.includes(entry.trigger))
          .slice(0, 7)
      : matches;
    selected = visible.length > 0 ? 0 : -1;
    optionElements = [];

    if (visible.length === 0) {
      results.replaceChildren(
        el(
          "div",
          "px-4 py-4 text-center text-sm text-text-secondary",
          `No bang found for "${parts.search}"`
        )
      );
    } else {
      optionElements = visible.map((entry, index) => {
        const row = el(
          "button",
          "command-result flex w-full items-center gap-3 border-none px-2.5 py-2 text-left text-text cursor-pointer"
        );
        row.id = `bang-command-option-${index}`;
        row.type = "button";
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(index === selected));
        row.append(
          el(
            "code",
            "command-badge min-w-16 rounded-md px-2 py-0.5 text-center font-mono text-xs font-semibold",
            `${parts.marker}${parts.chainPrefix ?? ""}${entry.trigger}`
          ),
          el("span", "min-w-0 flex-1 truncate text-sm font-medium", entry.name),
          el(
            "span",
            "hidden max-w-36 truncate text-xs text-text-secondary sm:block",
            entry.domain
          )
        );
        row.addEventListener("pointerenter", () => {
          setSelection(index);
        });
        row.addEventListener("click", () =>
          select(
            entry,
            parts.marker,
            parts.terms,
            `${parts.chainPrefix ?? ""}${entry.trigger}`
          )
        );
        return row;
      });
      results.replaceChildren(...optionElements);
    }
    results.classList.remove("hidden");
    input.setAttribute("aria-expanded", "true");
    renderSelection(-1, false);
  }

  function loadEntries(): Promise<void> {
    if (entries) {
      return Promise.resolve();
    }
    if (loading) {
      return loading;
    }
    const version = catalogVersion;
    const request = Promise.all([
      loadBuiltinBangCatalog(),
      db.getAllCustomBangs().catch(() => []),
    ])
      .then(([catalog, custom]) => {
        if (version !== catalogVersion) {
          return;
        }
        if (custom.length === 0) {
          entries = catalog.entries;
        } else {
          const overrides = new Map(
            custom.map((bang) => [
              bang.trigger,
              createBangMeta(bang.trigger, bang.name, customDomain(bang.url)),
            ])
          );
          const merged = catalog.entries.map((entry) => {
            const override = overrides.get(entry.trigger);
            if (override) {
              overrides.delete(entry.trigger);
              return override;
            }
            return entry;
          });
          merged.push(...overrides.values());
          entries = merged;
        }
        count.textContent = `${entries.length.toLocaleString()} shortcuts`;
      })
      .catch(() => {
        if (version !== catalogVersion) {
          return;
        }
        entries = [];
        count.textContent = "Bang index unavailable";
      })
      .finally(() => {
        if (loading === request) {
          loading = null;
        }
        if (version === catalogVersion) {
          renderResults();
        }
      });
    loading = request;
    return request;
  }

  function refresh(): Promise<void> {
    catalogVersion++;
    entries = null;
    loading = null;
    return loadEntries();
  }

  function setPrefixes(bang: TriggerPrefix, snap: TriggerPrefix): void {
    bangPrefix = bang;
    snapPrefix = snap;
    defaultPlaceholder = `Search bangs or enter ${bangPrefix}gh react`;
    if (selectedCommand) {
      clearSelectedCommand();
    } else {
      input.placeholder = defaultPlaceholder;
      if (entries && input.value.trim()) {
        renderResults();
      } else {
        closeResults();
      }
    }
  }

  input.addEventListener("focus", () => void loadEntries());
  input.addEventListener("blur", () => {
    setTimeout(() => {
      if (!form.contains(document.activeElement)) {
        closeResults();
      }
    });
  });
  form.addEventListener("pointerenter", () => void loadEntries(), {
    once: true,
  });
  input.addEventListener("input", () => {
    if (selectedCommand) {
      closeResults();
      return;
    }
    if (entries) {
      renderResults();
    } else {
      void loadEntries();
    }
  });
  input.addEventListener("keydown", (event) => {
    const vimKey = event.ctrlKey ? event.key.toLowerCase() : "";
    const next =
      event.key === "ArrowDown" ||
      vimKey === "j" ||
      (event.key === "Tab" && !event.shiftKey);
    const previous =
      event.key === "ArrowUp" ||
      vimKey === "k" ||
      (event.key === "Tab" && event.shiftKey);
    if (event.key === "Backspace" && selectedCommand && input.value === "") {
      event.preventDefault();
      clearSelectedCommand();
    } else if (next && visible.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      setSelection((selected + 1) % visible.length);
    } else if (previous && visible.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      setSelection((selected - 1 + visible.length) % visible.length);
    } else if (event.key === "Escape") {
      if (selectedCommand) {
        clearSelectedCommand();
      } else {
        closeResults();
      }
    } else if (
      (event.key === "Enter" || vimKey === "y") &&
      selected >= 0 &&
      visible[selected]
    ) {
      const parts = commandParts();
      if (parts) {
        event.preventDefault();
        event.stopPropagation();
        select(
          visible[selected],
          parts.marker,
          parts.terms,
          `${parts.chainPrefix ?? ""}${visible[selected].trigger}`
        );
      }
    }
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const terms = input.value.trim();
    const query = selectedCommand
      ? `${selectedCommand.marker}${selectedCommand.trigger}${terms ? ` ${terms}` : ""}`
      : terms;
    if (query) {
      location.assign(`/?q=${encodeURIComponent(query)}`);
    }
  });
  selectedBadge.addEventListener("click", () => clearSelectedCommand(true));
  document.addEventListener("pointerdown", (event) => {
    if (event.target instanceof Node && !form.contains(event.target)) {
      closeResults();
    }
  });
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(() => void loadEntries(), { timeout: 1500 });
  } else {
    setTimeout(() => void loadEntries(), 800);
  }
  return { input, refresh, setPrefixes };
}
