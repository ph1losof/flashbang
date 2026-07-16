import { copyText } from "../clipboard";
import { $, el } from "../dom";
import { setupDialog } from "../modal";

type AddressBarBrowser = "brave" | "chrome" | "edge" | "firefox" | "safari";

interface BrowserGuide {
  docsLabel: string;
  docsUrl: string;
  name: string;
  settingsUrl?: string;
  steps: readonly string[];
  warning?: {
    label: string;
    text: string;
  };
}

const BROWSER_TABS: ReadonlyArray<{
  id: AddressBarBrowser;
  label: string;
}> = [
  { id: "chrome", label: "Chrome" },
  { id: "edge", label: "Edge" },
  { id: "firefox", label: "Firefox" },
  { id: "brave", label: "Brave" },
  { id: "safari", label: "Safari" },
];

const ACTIVE_TAB_CLASSES = ["border-success", "bg-success/10", "text-success"];
const INACTIVE_TAB_CLASSES = ["border-border", "bg-bg", "text-text-secondary"];

const BROWSER_GUIDES: Record<AddressBarBrowser, BrowserGuide> = {
  brave: {
    docsLabel: "Brave Help: Manage Search Engines",
    name: "Brave",
    settingsUrl: "brave://settings/search",
    steps: [
      "Select Manage Search Engines.",
      "If flashbang appears under Inactive Shortcuts, select Activate.",
      "Otherwise select Add and enter Search Engine: flashbang, Keyword: f (or another shortcut), and URL with %s in place of query: paste the Search URL from above.",
      "In Search Engines, open flashbang's three-dot menu and select Make default.",
    ],
    docsUrl:
      "https://support.brave.com/hc/en-us/articles/360017479752-How-do-I-set-my-default-search-engine",
  },
  chrome: {
    docsLabel: "Chrome Help: Manage search engines and site shortcuts",
    name: "Chrome",
    settingsUrl: "chrome://settings/searchEngines",
    steps: [
      "Under Site search, check Inactive shortcuts. If flashbang appears, select Activate.",
      "If it was not indexed automatically, select Add.",
      "Enter Search engine: flashbang, Shortcut: f (or another shortcut), and URL with %s in place of query: paste the Search URL from above.",
      "Open flashbang's More menu and select Make default.",
    ],
    docsUrl:
      "https://support.google.com/chrome/answer/95426?hl=en&co=GENIE.Platform%3DDesktop",
  },
  edge: {
    docsLabel: "Microsoft Support: Change your default search engine",
    name: "Microsoft Edge",
    settingsUrl: "edge://settings/searchEngines",
    steps: [
      "Edge can give bang destinations the same host-derived shortcut as flashbang, allowing the most recently used destination to take over plain searches.",
      "Delete the auto-discovered flashbang entry.",
      "Select Add and enter Search engine: flashbang, Shortcut: f (or another unique shortcut), and URL with %s: paste the Search URL you copied from above, not the optional Suggestions URL.",
      "Open the new flashbang entry's menu and select Make default.",
    ],
    warning: {
      label: "Important: do not only edit the auto-discovered shortcut.",
      text: "Edge restores it from OpenSearch after restarting, so delete and re-add the entry to make the fix persist.",
    },
    docsUrl:
      "https://support.microsoft.com/en-us/microsoft-edge/change-your-default-search-engine-in-microsoft-edge-cccaf51c-a4df-a43e-8036-d4d2c527a791",
  },
  firefox: {
    docsLabel: "Mozilla Support: Add a custom search engine",
    name: "Firefox",
    settingsUrl: "about:preferences#search",
    steps: [
      "Under Search Shortcuts, select Add.",
      "Enter flashbang as the Search engine name and paste the Search URL above into Engine URL.",
      "Optional: paste the Suggestions URL above into Search suggestion API URL to enable address-bar autocomplete, then save.",
      "Choose flashbang under Default Search Engine.",
    ],
    docsUrl:
      "https://support.mozilla.org/en-US/kb/add-or-remove-search-engine-firefox#w_add-a-custom-search-engine",
  },
  safari: {
    docsLabel: "Apple Support: Change Search settings",
    name: "Safari",
    steps: [
      "Choose Safari > Settings, then click Search.",
      "Safari's Search engine menu only offers its available providers and has no field for a custom URL template.",
      "A browser extension that supports custom URL templates is required to use Flashbang as Safari's default search engine.",
    ],
    docsUrl: "https://support.apple.com/guide/safari/search-sfria1042d31/mac",
  },
};

export function detectAddressBarBrowser(
  userAgent: string,
  isBrave = false
): AddressBarBrowser {
  const ua = userAgent.toLowerCase();
  if (ua.includes("firefox") || ua.includes("fxios")) {
    return "firefox";
  }
  if (ua.includes("edg/") || ua.includes("edga/") || ua.includes("edgios/")) {
    return "edge";
  }
  if (isBrave || ua.includes("brave")) {
    return "brave";
  }
  if (
    ua.includes("safari") &&
    !ua.includes("chrome") &&
    !ua.includes("crios")
  ) {
    return "safari";
  }
  return "chrome";
}

export function setupAddressBarSheet(): void {
  const modal = $("#setup-modal");
  const openButton = $<HTMLButtonElement>("#open-setup");
  const closeButton = $<HTMLButtonElement>("#setup-close");
  const status = $("#setup-copy-status");
  const searchUrl = $<HTMLInputElement>("#setup-search-url");
  const suggestUrl = $<HTMLInputElement>("#setup-suggest-url");
  const browserTabs = $("#setup-browser-tabs");
  const browserName = $("#setup-browser-name");
  const browserSteps = $("#setup-browser-steps");
  const browserDocs = $<HTMLAnchorElement>("#setup-browser-docs");
  let tabButtons: HTMLButtonElement[] = [];

  searchUrl.value = `${location.origin}?q=%s`;
  suggestUrl.value = `${location.origin}/suggest?q=%s`;

  function showBrowserGuide(browser: AddressBarBrowser): void {
    const guide = BROWSER_GUIDES[browser];
    for (const button of tabButtons) {
      const selected = button.dataset.browser === browser;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      button.classList.remove(...ACTIVE_TAB_CLASSES, ...INACTIVE_TAB_CLASSES);
      button.classList.add(
        ...(selected ? ACTIVE_TAB_CLASSES : INACTIVE_TAB_CLASSES)
      );
    }
    browserName.textContent = guide.name;
    const steps = guide.steps.map((step) => el("li", "pl-1", step));
    if (guide.settingsUrl) {
      const settingsUrl = guide.settingsUrl;
      const step = el("li", "pl-1");
      const link = el(
        "a",
        "font-mono font-semibold text-success underline decoration-success/70 underline-offset-2 cursor-pointer hover:text-text",
        settingsUrl
      );
      const linkWrap = el("span", "relative inline-flex");
      const tooltip = el(
        "span",
        "absolute bottom-full left-1/2 z-10 mb-2 -translate-x-1/2 whitespace-nowrap rounded-md bg-success px-2 py-1 text-xs font-semibold text-bg shadow-lg"
      );
      const tooltipText = el("span", "relative z-1", "Copied to clipboard");
      const tooltipArrow = el(
        "span",
        "absolute left-1/2 top-full h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-success"
      );
      tooltipArrow.setAttribute("aria-hidden", "true");
      tooltip.append(tooltipText, tooltipArrow);
      tooltip.role = "tooltip";
      tooltip.hidden = true;
      link.href = settingsUrl;
      link.setAttribute(
        "aria-label",
        `Copy ${settingsUrl} to open in your address bar`
      );
      let tooltipTimer = 0;
      function showTooltip(message: string): void {
        tooltipText.textContent = message;
        tooltip.hidden = false;
        window.clearTimeout(tooltipTimer);
        tooltipTimer = window.setTimeout(() => {
          tooltip.hidden = true;
        }, 1400);
      }
      link.addEventListener("click", async (event) => {
        event.preventDefault();
        try {
          await copyText(settingsUrl);
          showTooltip("Copied to clipboard");
          status.textContent = `${settingsUrl} copied. Paste it into your address bar.`;
        } catch {
          showTooltip("Could not copy");
          status.textContent = `Could not copy ${settingsUrl}`;
        }
      });
      linkWrap.append(link, tooltip);
      step.append("Open ", linkWrap, ".");
      steps.unshift(step);
    }
    if (guide.warning) {
      const warning = el("li", "pl-1");
      warning.append(
        el(
          "strong",
          "setup-browser-warning font-semibold text-amber-300",
          guide.warning.label
        ),
        ` ${guide.warning.text}`
      );
      steps.push(warning);
    }
    browserSteps.replaceChildren(...steps);
    browserDocs.href = guide.docsUrl;
    browserDocs.textContent = guide.docsLabel;
    browserDocs.setAttribute(
      "aria-label",
      `${guide.docsLabel} (opens in a new tab)`
    );
  }

  function handleTabKeydown(
    event: KeyboardEvent,
    button: HTMLButtonElement
  ): void {
    const current = tabButtons.indexOf(button);
    let next = current;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = (current + 1) % tabButtons.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = (current - 1 + tabButtons.length) % tabButtons.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = tabButtons.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    const nextButton = tabButtons[next];
    showBrowserGuide(nextButton.dataset.browser as AddressBarBrowser);
    nextButton.focus();
  }

  setupDialog({
    closeButton,
    modal,
    openButton,
    onFirstOpen() {
      const navigatorWithBrave = navigator as Navigator & { brave?: unknown };
      const browser = detectAddressBarBrowser(
        navigator.userAgent,
        Boolean(navigatorWithBrave.brave)
      );
      tabButtons = BROWSER_TABS.map(({ id, label }) => {
        const button = el(
          "button",
          "rounded-full border px-3 py-1.5 text-xs font-semibold cursor-pointer transition-colors hover:border-text-secondary hover:bg-bg-hover hover:text-text",
          label
        );
        button.type = "button";
        button.role = "tab";
        button.dataset.browser = id;
        button.setAttribute("aria-controls", "setup-browser-panel");
        button.addEventListener("click", () => showBrowserGuide(id));
        button.addEventListener("keydown", (event) =>
          handleTabKeydown(event, button)
        );
        return button;
      });
      browserTabs.replaceChildren(...tabButtons);
      showBrowserGuide(browser);
    },
  });

  async function copy(
    input: HTMLInputElement,
    button: HTMLButtonElement
  ): Promise<void> {
    const label = button.querySelector<HTMLElement>("[data-copy-label]")!;
    try {
      await copyText(input.value, input);
      label.textContent = "Copied";
      button.classList.add("copied");
      status.textContent = `${button.dataset.label} copied`;
      window.setTimeout(() => {
        label.textContent = "Copy";
        button.classList.remove("copied");
      }, 1400);
    } catch {
      status.textContent = "Could not copy URL";
      input.focus();
      input.select();
    }
  }

  for (const [buttonId, input] of [
    ["#copy-search-url", searchUrl],
    ["#copy-suggest-url", suggestUrl],
  ] as const) {
    const button = $<HTMLButtonElement>(buttonId);
    button.addEventListener("click", () => void copy(input, button));
    input.addEventListener("click", () => input.select());
  }
}
