import { afterEach, describe, expect, test } from "bun:test";
import { copyText } from "../src/ui/clipboard";
import { $, el } from "../src/ui/dom";
import { firefoxSuggestionUrl } from "../src/ui/firefox-suggest";
import {
  detectAddressBarBrowser,
  setupAddressBarSheet,
} from "../src/ui/home/address-bar-setup";
import { setupDialog } from "../src/ui/modal";

type Listener = (event: TestEvent) => void | Promise<void>;

class TestEvent {
  defaultPrevented = false;
  target: TestElement | null;

  constructor(
    public key = "",
    public shiftKey = false,
    target: TestElement | null = null
  ) {
    this.target = target;
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

class TestClassList {
  private classes = new Set<string>();

  constructor(value = "") {
    for (const cls of value.split(/\s+/).filter(Boolean)) {
      this.classes.add(cls);
    }
  }

  add(...classes: string[]): void {
    for (const cls of classes) {
      this.classes.add(cls);
    }
  }

  contains(cls: string): boolean {
    return this.classes.has(cls);
  }

  remove(...classes: string[]): void {
    for (const cls of classes) {
      this.classes.delete(cls);
    }
  }

  replace(oldClass: string, newClass: string): boolean {
    const hadClass = this.classes.delete(oldClass);
    if (hadClass) {
      this.classes.add(newClass);
    }
    return hadClass;
  }

  toString(): string {
    return [...this.classes].join(" ");
  }
}

class TestElement {
  attributes = new Map<string, string>();
  children: TestElement[] = [];
  classList = new TestClassList();
  dataset: Record<string, string> = {};
  hidden = false;
  href = "";
  id = "";
  parent: TestElement | null = null;
  role = "";
  selected = false;
  style: Record<string, string> = {};
  tabIndex = 0;
  textContent = "";
  type = "";
  value = "";
  private listeners = new Map<string, Listener[]>();

  constructor(public tagName: string) {}

  set className(value: string) {
    this.classList = new TestClassList(value);
  }

  get className(): string {
    return this.classList.toString();
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  append(...items: Array<TestElement | string>): void {
    for (const item of items) {
      if (typeof item === "string") {
        this.textContent += item;
      } else {
        item.parent = this;
        this.children.push(item);
      }
    }
  }

  click(): void {
    void this.dispatch("click", new TestEvent("", false, this));
  }

  async dispatch(
    type: string,
    event = new TestEvent("", false, this)
  ): Promise<TestEvent> {
    event.target ??= this;
    for (const listener of this.listeners.get(type) ?? []) {
      await listener(event);
    }
    return event;
  }

  focus(): void {
    testDocument.activeElement = this;
  }

  querySelector<T extends TestElement = TestElement>(
    selector: string
  ): T | null {
    return this.querySelectorAll<T>(selector)[0] ?? null;
  }

  querySelectorAll<T extends TestElement = TestElement>(selector: string): T[] {
    const matches: T[] = [];
    const visit = (node: TestElement): void => {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) {
          matches.push(child as T);
        }
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  remove(): void {
    if (!this.parent) {
      return;
    }
    this.parent.children = this.parent.children.filter(
      (child) => child !== this
    );
    this.parent = null;
  }

  replaceChildren(...children: TestElement[]): void {
    this.children = [];
    this.append(...children);
  }

  select(): void {
    this.selected = true;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "id") {
      this.id = value;
    } else if (name === "role") {
      this.role = value;
    } else if (name.startsWith("data-")) {
      this.dataset[name.slice(5)] = value;
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setSelectionRange(start: number, end: number): void {
    this.attributes.set("selection", `${start}:${end}`);
  }
}

const testDocument = {
  activeElement: null as TestElement | null,
  body: new TestElement("body"),
  listeners: new Map<string, Listener[]>(),
  createElement(tag: string) {
    return new TestElement(tag);
  },
  querySelector(selector: string) {
    return this.body.querySelector(selector);
  },
  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  },
  async dispatch(type: string, event: TestEvent) {
    for (const listener of this.listeners.get(type) ?? []) {
      await listener(event);
    }
  },
  execCommand(_command: string) {
    return true;
  },
};

const originalDocument = globalThis.document;
const originalLocation = globalThis.location;
const originalNavigator = globalThis.navigator;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const originalWindow = globalThis.window;

function restoreGlobal(
  name: "document" | "location" | "window",
  value: unknown
): void {
  if (value === undefined) {
    Reflect.deleteProperty(globalThis, name);
    return;
  }
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value,
  });
}

function setNavigator(value: unknown): void {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value,
  });
}

afterEach(() => {
  restoreGlobal("document", originalDocument);
  restoreGlobal("location", originalLocation);
  restoreGlobal("window", originalWindow);
  setNavigator(originalNavigator);
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
});

function installDom(): void {
  testDocument.body = new TestElement("body");
  testDocument.activeElement = null;
  testDocument.listeners = new Map();
  testDocument.execCommand = () => true;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: testDocument,
  });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: "https://flashbang.test" },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: globalThis,
  });
  globalThis.setTimeout = ((handler: TimerHandler) => {
    if (typeof handler === "function") {
      handler();
    }
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = (() => undefined) as typeof clearTimeout;
}

function matchesSelector(element: TestElement, selector: string): boolean {
  if (
    selector ===
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  ) {
    return (
      ["button", "input", "select", "textarea"].includes(element.tagName) ||
      Boolean(element.href) ||
      element.tabIndex !== -1
    );
  }
  if (selector.startsWith("#")) {
    return element.id === selector.slice(1);
  }
  if (selector === '[role="dialog"]') {
    return element.role === "dialog";
  }
  if (selector === "[data-copy-label]") {
    return Object.hasOwn(element.dataset, "copyLabel");
  }
  return element.tagName === selector;
}

function appendElement(tag: string, id: string): TestElement {
  const element = new TestElement(tag);
  element.id = id;
  testDocument.body.append(element);
  return element;
}

function setupAddressBarDom(): Record<string, TestElement> {
  installDom();
  const modal = appendElement("div", "setup-modal");
  modal.className = "opacity-0 invisible";
  const card = new TestElement("section");
  card.role = "dialog";
  modal.append(card);
  const open = appendElement("button", "open-setup");
  const close = appendElement("button", "setup-close");
  const status = appendElement("p", "setup-copy-status");
  const searchUrl = appendElement("input", "setup-search-url");
  const suggestUrl = appendElement("input", "setup-suggest-url");
  const browserTabs = appendElement("div", "setup-browser-tabs");
  const browserPanel = appendElement("section", "setup-browser-panel");
  const browserName = appendElement("h2", "setup-browser-name");
  const browserSteps = appendElement("ol", "setup-browser-steps");
  const browserDocs = appendElement("a", "setup-browser-docs");
  for (const [id, label] of [
    ["copy-search-url", "Search URL"],
    ["copy-suggest-url", "Suggestions URL"],
  ]) {
    const button = appendElement("button", id);
    button.dataset.label = label;
    const copyLabel = new TestElement("span");
    copyLabel.dataset.copyLabel = "";
    copyLabel.textContent = "Copy";
    button.append(copyLabel);
  }
  return {
    browserDocs,
    browserName,
    browserPanel,
    browserSteps,
    browserTabs,
    close,
    modal,
    open,
    searchUrl,
    status,
    suggestUrl,
  };
}

describe("address bar browser detection", () => {
  test("detects Chromium browsers before the Chrome fallback", () => {
    const chromium = "Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36";

    expect(detectAddressBarBrowser(`${chromium} Edg/126.0.0.0`)).toBe("edge");
    expect(detectAddressBarBrowser(`${chromium} EdgA/126.0.0.0`)).toBe("edge");
    expect(detectAddressBarBrowser(chromium, true)).toBe("brave");
    expect(detectAddressBarBrowser(chromium)).toBe("chrome");
  });

  test("detects Firefox and Safari", () => {
    expect(detectAddressBarBrowser("Mozilla/5.0 Firefox/128.0")).toBe(
      "firefox"
    );
    expect(
      detectAddressBarBrowser("Mozilla/5.0 Version/17.5 Safari/605.1.15")
    ).toBe("safari");
    expect(detectAddressBarBrowser("Mozilla/5.0 FxiOS/128.0")).toBe("firefox");
  });

  test("detects Edge on iOS", () => {
    expect(
      detectAddressBarBrowser("Mozilla/5.0 EdgiOS/126.0 Mobile/15E148")
    ).toBe("edge");
  });
});

describe("Firefox suggestion URL", () => {
  test("adds provider and only includes non-default syntax", () => {
    expect(
      firefoxSuggestionUrl("https://example.com", {
        bangPrefix: "!",
        provider: "google",
        snapPrefix: "@",
      })
    ).toBe("https://example.com/suggest?q=%s&sp=google");
    expect(
      firefoxSuggestionUrl("https://example.com", {
        bangPrefix: "$",
        provider: "startpage",
        snapPrefix: "~",
      })
    ).toBe("https://example.com/suggest?q=%s&sp=startpage&bp=%24&np=~");
  });
});

describe("DOM helpers", () => {
  test("creates elements and reports missing selectors", () => {
    installDom();

    const button = el("button", "primary", "Copy");
    button.id = "copy";
    testDocument.body.append(button as unknown as TestElement);

    expect($("#copy")).toBe(button);
    expect(button.className).toBe("primary");
    expect(button.textContent).toBe("Copy");
    expect(() => $("#missing")).toThrow("Missing: #missing");
    expect(el("span", "").className).toBe("");
  });
});

describe("clipboard helper", () => {
  test("uses navigator clipboard when available", async () => {
    installDom();
    const writes: string[] = [];
    setNavigator({
      clipboard: { writeText: async (text: string) => writes.push(text) },
    });

    await copyText("hello");

    expect(writes).toEqual(["hello"]);
    expect(testDocument.body.children).toHaveLength(0);
  });

  test("falls back to execCommand and cleans temporary textareas", async () => {
    installDom();
    setNavigator({
      clipboard: {
        writeText: () => Promise.reject(new Error("denied")),
      },
    });
    let copiedValue = "";
    testDocument.execCommand = () => {
      copiedValue =
        testDocument.body.querySelector<TestElement>("textarea")?.value ?? "";
      return true;
    };

    await copyText("fallback copy");

    expect(copiedValue).toBe("fallback copy");
    expect(testDocument.body.children).toHaveLength(0);
  });

  test("reuses fallback inputs and throws when copy fails", async () => {
    installDom();
    setNavigator({});
    testDocument.execCommand = () => false;
    const input = new TestElement("input");

    await expect(
      copyText("manual", input as unknown as HTMLInputElement)
    ).rejects.toThrow("Clipboard write failed");

    expect(input.value).toBe("manual");
    expect(input.selected).toBe(true);
    expect(input.getAttribute("selection")).toBe("0:0");
  });
});

describe("modal dialog", () => {
  test("opens once, closes from backdrop and traps focus", async () => {
    installDom();
    const modal = new TestElement("div");
    modal.className = "opacity-0 invisible";
    const card = new TestElement("section");
    card.role = "dialog";
    const first = new TestElement("button");
    const last = new TestElement("button");
    card.append(first, last);
    modal.append(card);
    const openButton = new TestElement("button");
    const closeButton = new TestElement("button");
    let firstOpenCount = 0;

    const dialog = setupDialog({
      closeButton: closeButton as unknown as HTMLElement,
      modal: modal as unknown as HTMLElement,
      onFirstOpen: () => firstOpenCount++,
      openButton: openButton as unknown as HTMLElement,
    });

    dialog.openDialog();
    dialog.openDialog();
    expect(firstOpenCount).toBe(1);
    expect(modal.classList.contains("open")).toBe(true);
    expect(modal.getAttribute("aria-hidden")).toBe("false");
    expect(openButton.getAttribute("aria-expanded")).toBe("true");
    expect(testDocument.body.style.overflow).toBe("hidden");
    expect(testDocument.activeElement).toBe(closeButton);

    last.focus();
    const tab = await modal.dispatch(
      "keydown",
      new TestEvent("Tab", false, modal)
    );
    expect(tab.defaultPrevented).toBe(true);
    expect(testDocument.activeElement).toBe(first);

    first.focus();
    const shiftTab = await modal.dispatch(
      "keydown",
      new TestEvent("Tab", true, modal)
    );
    expect(shiftTab.defaultPrevented).toBe(true);
    expect(testDocument.activeElement).toBe(last);

    await modal.dispatch("click", new TestEvent("", false, modal));
    expect(modal.classList.contains("open")).toBe(false);
    expect(modal.getAttribute("aria-hidden")).toBe("true");
    expect(testDocument.activeElement).toBe(openButton);
  });

  test("closes on Escape and requires a dialog card", async () => {
    installDom();
    const modal = new TestElement("div");
    const openButton = new TestElement("button");
    const closeButton = new TestElement("button");

    expect(() =>
      setupDialog({
        closeButton: closeButton as unknown as HTMLElement,
        modal: modal as unknown as HTMLElement,
        openButton: openButton as unknown as HTMLElement,
      })
    ).toThrow("Dialog card not found");

    const card = new TestElement("section");
    card.role = "dialog";
    modal.append(card);
    const dialog = setupDialog({
      closeButton: closeButton as unknown as HTMLElement,
      modal: modal as unknown as HTMLElement,
      openButton: openButton as unknown as HTMLElement,
    });
    dialog.openDialog();
    await testDocument.dispatch("keydown", new TestEvent("Escape"));

    expect(modal.classList.contains("open")).toBe(false);
  });
});

describe("address bar setup sheet", () => {
  test("initializes browser tabs on first open and refreshes Firefox suggestions", async () => {
    const dom = setupAddressBarDom();
    setNavigator({ userAgent: "Mozilla/5.0 Firefox/128.0" });

    const sheet = setupAddressBarSheet(() => ({
      bangPrefix: "$",
      provider: "startpage",
      snapPrefix: "~",
    }));
    dom.open.click();

    expect(dom.searchUrl.value).toBe("https://flashbang.test?q=%s");
    expect(dom.suggestUrl.value).toBe(
      "https://flashbang.test/suggest?q=%s&sp=startpage&bp=%24&np=~"
    );
    expect(dom.browserTabs.children).toHaveLength(5);
    expect(dom.browserName.textContent).toBe("Firefox");
    expect(dom.browserPanel.getAttribute("aria-labelledby")).toBe(
      "setup-browser-tab-firefox"
    );
    expect(dom.browserDocs.href).toContain("support.mozilla.org");

    sheet.refreshSuggestionUrl();
    expect(dom.suggestUrl.value).toContain("sp=startpage");

    const firefoxTab = dom.browserTabs.children[2];
    const keyEvent = await firefoxTab.dispatch(
      "keydown",
      new TestEvent("ArrowRight")
    );
    expect(keyEvent.defaultPrevented).toBe(true);
    expect(dom.browserName.textContent).toBe("Brave");
    expect(testDocument.activeElement).toBe(dom.browserTabs.children[3]);
  });

  test("copies URLs and handles settings link copy failures", async () => {
    const dom = setupAddressBarDom();
    setNavigator({
      userAgent: "Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36",
    });
    let shouldCopy = true;
    testDocument.execCommand = () => shouldCopy;

    setupAddressBarSheet(() => ({
      bangPrefix: "!",
      provider: "google",
      snapPrefix: "@",
    }));
    dom.open.click();
    dom.searchUrl.value = "https://flashbang.test?q=%s";
    await dom.browserSteps.querySelector<TestElement>("a")?.dispatch("click");

    expect(dom.status.textContent).toBe(
      "chrome://settings/searchEngines copied. Paste it into your address bar."
    );

    const copySearch = $("#copy-search-url") as unknown as TestElement;
    await copySearch.dispatch("click");
    expect(copySearch.classList.contains("copied")).toBe(false);
    expect(dom.status.textContent).toBe("Search URL copied");

    shouldCopy = false;
    await dom.browserSteps.querySelector<TestElement>("a")?.dispatch("click");
    expect(dom.status.textContent).toBe(
      "Could not copy chrome://settings/searchEngines"
    );

    const suggestInput = $("#setup-suggest-url") as unknown as TestElement;
    await ($("#copy-suggest-url") as unknown as TestElement).dispatch("click");
    expect(dom.status.textContent).toBe("Could not copy URL");
    expect(testDocument.activeElement).toBe(suggestInput);
    expect(suggestInput.selected).toBe(true);
  });

  test("renders Edge warning and supports Home and End tab keys", () => {
    const dom = setupAddressBarDom();
    setNavigator({
      userAgent: "Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
    });

    setupAddressBarSheet(() => ({
      bangPrefix: "!",
      provider: "google",
      snapPrefix: "@",
    }));
    dom.open.click();

    expect(dom.browserName.textContent).toBe("Microsoft Edge");
    expect(dom.browserSteps.querySelector("strong")?.textContent).toContain(
      "Important"
    );

    const edgeTab = dom.browserTabs.children[1];
    void edgeTab.dispatch("keydown", new TestEvent("End"));
    expect(dom.browserName.textContent).toBe("Safari");
    void dom.browserTabs.children[4].dispatch("keydown", new TestEvent("Home"));
    expect(dom.browserName.textContent).toBe("Chrome");
  });
});
