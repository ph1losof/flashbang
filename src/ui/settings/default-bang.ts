import type { CustomBangRecord } from "../../shared/capture-template";
import type { TriggerPrefix } from "../../shared/trigger-prefix";
import { flashAnim, shakeAnim } from "../animations";
import {
  type BangMeta,
  createBangMeta,
  loadBuiltinBangCatalog,
  searchBangs,
} from "../bang-catalog";
import type { DB } from "../db";
import { $, el } from "../dom";
import { notifySW } from "../sw-bridge";
import type { RunWrite } from "./write";

interface DefaultBangOptions {
  db: DB;
  initialCustom: readonly CustomBangRecord[];
  initialBang: string;
  getBangPrefix: () => TriggerPrefix;
  onCommit: (trigger: string) => void;
  runWrite: RunWrite;
}

export interface DefaultBangController {
  setCommitted: (trigger: string) => string;
  setCustomBangs: (bangs: readonly CustomBangRecord[]) => string;
}

export async function setupDefaultBangSetting({
  db,
  getBangPrefix,
  initialCustom,
  initialBang,
  onCommit,
  runWrite,
}: DefaultBangOptions): Promise<DefaultBangController> {
  const input = $<HTMLInputElement>("#default-bang");
  const results = $("#default-bang-results");
  const status = $("#bang-status");
  const catalog = await loadBuiltinBangCatalog();
  const eligibleBuiltins = catalog.entries.filter((bang) => !bang.capture);
  const eligibleByTrigger = new Map(
    eligibleBuiltins.map((bang) => [bang.trigger, bang])
  );
  let byTrigger: ReadonlyMap<string, BangMeta> = eligibleByTrigger;
  let entries: readonly BangMeta[] = eligibleBuiltins;
  let committedBang = initialBang;
  let previewTimer: ReturnType<typeof setTimeout>;
  let hits: BangMeta[] = [];
  let optionElements: HTMLButtonElement[] = [];
  let selected = -1;

  function setCustomBangs(bangs: readonly CustomBangRecord[]): string {
    const combined = new Map(eligibleByTrigger);
    for (const bang of bangs) {
      if (bang.regex) {
        combined.delete(bang.trigger);
        continue;
      }
      let domain = "Custom";
      try {
        domain = new URL(bang.url).hostname || domain;
      } catch {
        /* Persisted imports are validated elsewhere. */
      }
      combined.set(
        bang.trigger,
        createBangMeta(bang.trigger, bang.name, domain)
      );
    }
    byTrigger = combined;
    entries = [...combined.values()];
    if (!byTrigger.has(committedBang)) {
      committedBang = "g";
    }
    const current = byTrigger.get(committedBang);
    input.value = committedBang;
    status.textContent = current?.name || "Unknown";
    status.className = current ? "text-sm text-success" : "text-sm text-danger";
    return committedBang;
  }

  setCustomBangs(initialCustom);
  input.value = committedBang;
  status.textContent = byTrigger.get(committedBang)?.name || "Unknown";

  function closePreview(): void {
    results.classList.add("hidden");
    results.replaceChildren();
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    hits = [];
    optionElements = [];
    selected = -1;
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

  function selectBang(bang: BangMeta): void {
    input.value = bang.trigger;
    closePreview();
    input.dispatchEvent(new Event("change"));
  }

  function setCommitted(trigger: string): string {
    committedBang = byTrigger.has(trigger) ? trigger : "g";
    const bang = byTrigger.get(committedBang);
    input.value = committedBang;
    status.textContent = bang?.name || "Unknown";
    status.className = bang ? "text-sm text-success" : "text-sm text-danger";
    return committedBang;
  }

  input.addEventListener("input", () => {
    clearTimeout(previewTimer);
    const raw = input.value.trim();
    const query = (raw.startsWith(getBangPrefix()) ? raw.substring(1) : raw)
      .trim()
      .toLowerCase();
    if (!query) {
      closePreview();
      return;
    }
    previewTimer = setTimeout(() => {
      hits = searchBangs(entries, query, 6);
      selected = hits.length > 0 ? 0 : -1;
      optionElements = [];
      if (hits.length === 0) {
        results.replaceChildren(
          el(
            "div",
            "px-2.5 py-2 text-center text-xs text-text-secondary",
            "No matching bangs"
          )
        );
      } else {
        optionElements = hits.map((bang, index) => {
          const { trigger, name, domain } = bang;
          const row = el(
            "button",
            "command-result flex w-full items-center gap-2 rounded-md border-none px-2 py-1.5 text-left text-text cursor-pointer"
          );
          row.id = `default-bang-option-${index}`;
          row.type = "button";
          row.dataset.trigger = trigger;
          row.setAttribute("role", "option");
          row.setAttribute("aria-selected", String(index === selected));
          row.append(
            el(
              "code",
              "command-badge min-w-14 rounded-md px-2 py-0.5 text-center font-mono text-xs font-semibold",
              `${getBangPrefix()}${trigger}`
            ),
            el("span", "min-w-0 flex-1 truncate text-xs font-medium", name),
            el(
              "span",
              "hidden max-w-28 truncate text-[10px] text-text-secondary sm:block",
              domain
            )
          );
          row.addEventListener("pointerdown", (event) => {
            event.preventDefault();
          });
          row.addEventListener("pointerenter", () => setSelection(index));
          row.addEventListener("click", () => selectBang(bang));
          return row;
        });
        results.replaceChildren(...optionElements);
      }
      results.classList.remove("hidden");
      input.setAttribute("aria-expanded", "true");
      renderSelection(-1, false);
    }, 120);
  });

  input.addEventListener("keydown", (event) => {
    const vimKey = event.ctrlKey ? event.key.toLowerCase() : "";
    const next = event.key === "ArrowDown" || vimKey === "j";
    const previous = event.key === "ArrowUp" || vimKey === "k";
    if (next && hits.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      setSelection((selected + 1) % hits.length);
    } else if (previous && hits.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      setSelection((selected - 1 + hits.length) % hits.length);
    } else if (event.key === "Escape") {
      closePreview();
    } else if (
      (event.key === "Enter" || vimKey === "y") &&
      selected >= 0 &&
      hits[selected]
    ) {
      event.preventDefault();
      event.stopPropagation();
      selectBang(hits[selected]);
    }
  });

  input.addEventListener("change", () => {
    closePreview();
    const raw = input.value.trim();
    const value = (raw.startsWith(getBangPrefix()) ? raw.substring(1) : raw)
      .toLowerCase()
      .trim();
    const bang = byTrigger.get(value);
    if (!bang) {
      shakeAnim(input);
      status.textContent = "Unknown bang";
      status.className = "text-sm text-danger";
      return;
    }
    void runWrite(() => db.setSetting("default-bang", value), {
      key: "default-bang",
      onCommit: () => {
        committedBang = value;
        notifySW("invalidate");
        onCommit(value);
        flashAnim(input);
        status.textContent = bang.name;
        status.className = "text-sm text-success";
      },
      onFailure: () => {
        input.value = committedBang;
        status.textContent = byTrigger.get(committedBang)?.name || "Unknown";
        status.className = "text-sm text-danger";
      },
    });
  });

  return { setCommitted, setCustomBangs };
}
