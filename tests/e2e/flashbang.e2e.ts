import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { DB_VERSION } from "../../src/shared/constants";
import { encodeSuggestCookieValue } from "../../src/shared/suggest-cookie";
import { SETTINGS_SCHEMA_VERSION } from "../../src/ui/db";

const GOOGLE_REDIRECT = /google\.com\/search\?q=hello/;
const GOOGLE_HOST = "https://www.google.com";
const CUSTOM_HOST = "https://example.com";

async function mockGoogleSearchRoute(page: Page): Promise<void> {
  await page.context().route(`${GOOGLE_HOST}/**`, (route) => {
    const url = route.request().url();
    route.fulfill({
      status: 200,
      contentType: "text/plain",
      body: `mocked ${url}`,
    });
  });
  page.on("framenavigated", async (frame) => {
    if (frame !== page.mainFrame()) {
      return;
    }
    const url = new URL(frame.url());
    const continued = url.pathname.startsWith("/sorry/")
      ? url.searchParams.get("continue")
      : null;
    if (!continued?.startsWith(`${GOOGLE_HOST}/`)) {
      return;
    }
    // Firefox can bypass Playwright routing for a Service Worker 302. Preserve
    // the requested URL if Google's anti-bot page answers that test request.
    await frame
      .evaluate((target) => history.replaceState(null, "", target), continued)
      .catch(() => {
        // The navigation assertion reports a useful failure if rewriting fails.
      });
  });
}

async function mockCustomHostRoute(page: Page): Promise<void> {
  await page.context().route(`${CUSTOM_HOST}/**`, (route) => {
    const url = route.request().url();
    route.fulfill({
      status: 200,
      contentType: "text/plain",
      body: `custom ${url}`,
    });
  });
}

async function ensureWarmController(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () =>
          "serviceWorker" in navigator &&
          navigator.serviceWorker.controller !== null,
        { timeout: 10_000 }
      );
      return;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error ?? "");
      if (
        message.includes("interrupted by another navigation") ||
        message.includes("Execution context was destroyed") ||
        message.includes("NS_BINDING_ABORTED")
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("failed to establish service worker controller in warm mode");
}

async function navigateAndWaitForRedirect(
  page: Page,
  target: string,
  expectedUrl: RegExp
): Promise<void> {
  const navigation = page
    .goto(target, { waitUntil: "commit" })
    .catch((error) => {
      const message =
        error instanceof Error ? error.message : String(error ?? "");
      if (
        message.includes("ERR_ABORTED") ||
        message.includes("interrupted by another navigation")
      ) {
        return null;
      }
      throw error;
    });
  await expect.poll(() => page.url(), { timeout: 10_000 }).toMatch(expectedUrl);
  await navigation;
}

function resolveRedirectViaWorker(
  page: Page,
  query: string,
  invalidate = false
): Promise<string> {
  return page.evaluate(
    ({ invalidateCache, redirectQuery }) =>
      new Promise<string>((resolve, reject) => {
        const controller = navigator.serviceWorker.controller;
        if (!controller) {
          reject(new Error("service worker controller not found"));
          return;
        }
        navigator.serviceWorker.addEventListener(
          "message",
          (event) => resolve(event.data.url),
          { once: true }
        );
        if (invalidateCache) {
          controller.postMessage({ type: "invalidate" });
        }
        controller.postMessage({ type: "redirect", query: redirectQuery });
      }),
    { invalidateCache: invalidate, redirectQuery: query }
  );
}

async function seedCustomBangs(
  page: Page,
  bangs: Array<{
    trigger: string;
    name: string;
    url: string;
    regex?: string;
    encoding?: "percent" | "plus" | "raw";
    snap?: string;
  }>
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.waitForLoadState("domcontentloaded");
      await page.evaluate(async (customBangs) => {
        await new Promise<void>((resolve, reject) => {
          const req = indexedDB.open("flashbang", 1);

          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains("settings")) {
              db.createObjectStore("settings", { keyPath: "key" });
            }
            if (!db.objectStoreNames.contains("custom-bangs")) {
              db.createObjectStore("custom-bangs", { keyPath: "trigger" });
            }
          };

          req.onerror = () => {
            reject(req.error ?? new Error("failed to open IndexedDB"));
          };

          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction("custom-bangs", "readwrite");
            const store = tx.objectStore("custom-bangs");
            for (const bang of customBangs) {
              store.put(bang);
            }
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => {
              db.close();
              reject(tx.error ?? new Error("failed to write custom bangs"));
            };
            tx.onabort = () => {
              db.close();
              reject(tx.error ?? new Error("custom bang transaction aborted"));
            };
          };
        });
      }, bangs);

      await page.evaluate(() => {
        navigator.serviceWorker.controller?.postMessage({ type: "invalidate" });
      });
      return;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error ?? "");
      if (message.includes("Execution context was destroyed")) {
        continue;
      }
      throw error;
    }
  }

  throw new Error("failed to seed custom bangs after retries");
}

async function openHome(page: Page): Promise<void> {
  const target = test.info().project.name === "webkit" ? "/home" : "/";
  try {
    await page.goto(target, { waitUntil: "domcontentloaded" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("interrupted by another navigation")) {
      throw error;
    }
  }
  await page.waitForSelector("#gear-btn");
}

async function openSettingsModal(page: Page): Promise<void> {
  await openHome(page);
  await page.click("#gear-btn");
  await expect(page.locator("#settings-modal")).toHaveAttribute(
    "aria-hidden",
    "false"
  );
  await expect(page.locator("#bang-status")).not.toHaveText("");
}

async function settingsWriteCount(page: Page): Promise<number> {
  return Number(
    await page.locator("#settings-save-status").getAttribute("data-write-count")
  );
}

async function waitForSettingsWrite(
  page: Page,
  previousCount: number,
  writes = 1,
  state = "saved"
): Promise<void> {
  const status = page.locator("#settings-save-status");
  await expect
    .poll(async () => Number(await status.getAttribute("data-write-count")))
    .toBeGreaterThanOrEqual(previousCount + writes);
  await expect(status).toHaveAttribute("data-pending", "0");
  await expect(status).toHaveAttribute("data-state", state);
  if (state === "saved") {
    await expect(status).toHaveAttribute("aria-label", "Settings saved");
    await expect(page.locator("#settings-saved-icon")).toBeVisible();
    await expect(page.locator("#settings-saving-icon")).toBeHidden();
  }
}

async function submitCustomBangForm(
  page: Page,
  expectWrite = true
): Promise<void> {
  const writeCount = expectWrite ? await settingsWriteCount(page) : 0;
  await page.evaluate(() => {
    const form = document.querySelector("#add-bang-form");
    if (!(form instanceof HTMLFormElement)) {
      throw new Error("custom bang form not found");
    }
    form.requestSubmit();
  });
  if (expectWrite) {
    await waitForSettingsWrite(page, writeCount);
  }
}

test("suggest endpoint returns 400 when q parameter is missing", async ({
  request,
}) => {
  const response = await request.get("/suggest");
  expect(response.status()).toBe(400);
  await expect(response.text()).resolves.toContain("Missing q parameter");
});

test("suggest endpoint respects provider override via sp=none", async ({
  request,
}) => {
  const response = await request.get("/suggest", {
    params: { q: "hello", sp: "none" },
  });
  expect(response.status()).toBe(200);
  await expect(response.json()).resolves.toEqual(["hello", []]);
});

test("benchmark page loads its feature bundle", async ({ page }) => {
  await page.goto("/bench", { waitUntil: "domcontentloaded" });

  await expect(page).toHaveTitle("flashbang — Service Worker benchmark");
  await expect(page.locator(".wordmark")).toHaveClass(/has-shader/);
  await expect(page.locator("#run-btn")).toBeEnabled();
  const iterations = page.locator("#iterations");
  await iterations.focus();
  await iterations.press("Control+[");
  await expect(iterations).not.toBeFocused();

  await iterations.fill("100");
  await page.locator("#run-btn").click();
  const progressText = page.locator("#progress-text");
  await expect(progressText).toHaveText(/Done|Benchmark aborted/, {
    timeout: 30_000,
  });
  if ((await progressText.textContent()) !== "Done") {
    throw new Error((await page.locator("#sw-status").textContent()) ?? "");
  }
  await expect(page.locator("#stats-body tr")).toHaveCount(15);
  await expect(page.locator("#summary")).toContainText(
    "Service Worker transport baseline"
  );
  await expect(page.locator("#navigation-summary")).toContainText(
    "Paired top-level navigation"
  );
  await expect(page.locator("#sw-status")).toBeHidden();
});

test("Firefox locks cookie-backed suggestion settings", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0",
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText(value: string) {
          (
            window as typeof window & { copiedSuggestionUrl?: string }
          ).copiedSuggestionUrl = value;
          return Promise.resolve();
        },
      },
    });
  });

  await openSettingsModal(page);

  await expect(page.locator("#suggest-provider")).toBeDisabled();
  await expect(page.locator("#suggest-provider")).toHaveValue("google");
  await expect(page.locator("#suggest-provider")).toHaveClass(/select-locked/);
  await expect(page.locator("#suggest-url")).toBeDisabled();
  await expect(page.locator("#suggest-firefox-note")).toBeVisible();
  await expect(page.locator("#suggest-firefox-note")).toContainText(
    "Firefox does not send cookies for suggestions"
  );
  const origin = new URL(page.url()).origin;
  await expect(page.locator("#suggest-firefox-url")).toHaveText(
    `${origin}/suggest?q=%s&sp=google`
  );
  await expect(page.locator("#suggest-firefox-url span")).toHaveText("google");
  const providerPicker = page.locator("#suggest-firefox-provider-picker");
  await expect(providerPicker).toContainText("google");
  await providerPicker.hover();
  await expect(page.locator("#suggest-firefox-provider-menu")).toBeVisible();
  await page
    .locator('#suggest-firefox-provider-menu [data-provider="startpage"]')
    .click();
  let expectedUrl = `${origin}/suggest?q=%s&sp=startpage`;
  await expect(page.locator("#suggest-provider")).toHaveValue("google");
  await expect(page.locator("#suggest-firefox-url")).toHaveText(expectedUrl);
  await expect(page.locator("#suggest-firefox-url span")).toHaveText(
    "startpage"
  );
  await expect(providerPicker).toContainText("startpage");

  let writeCount = await settingsWriteCount(page);
  await page.selectOption("#bang-prefix", "$");
  await waitForSettingsWrite(page, writeCount);
  writeCount = await settingsWriteCount(page);
  await page.selectOption("#snap-prefix", "~");
  await waitForSettingsWrite(page, writeCount);
  expectedUrl = `${origin}/suggest?q=%s&sp=startpage&bp=%24&np=~`;
  await expect(page.locator("#suggest-firefox-url")).toHaveText(expectedUrl);

  await providerPicker.click();
  await expect(page.locator("#suggest-firefox-provider-menu")).toBeVisible();
  await providerPicker.click();
  await expect(page.locator("#suggest-firefox-provider-menu")).toBeHidden();
  await page.locator("#suggest-firefox-url").click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { copiedSuggestionUrl?: string })
            .copiedSuggestionUrl
      )
    )
    .toBe(expectedUrl);

  await page.click("#modal-close");
  await page.click("#open-setup");
  await expect(page.locator("#setup-suggest-url")).toHaveValue(expectedUrl);
});

test("suggest endpoint rewrites malformed suggest cookie context", async ({
  request,
}) => {
  const response = await request.get("/suggest", {
    params: { q: "!g" },
    headers: { Cookie: "suggest=custom,g,|f:%E0%A4%A" },
  });

  expect(response.status()).toBe(200);
  const setCookie = response.headers()["set-cookie"] ?? "";
  expect(setCookie).toContain("suggest=custom,g,");
  expect(setCookie).toContain("SameSite=Lax");
  expect(setCookie).toContain("Secure");

  const payload = await response.json();
  expect(payload[0]).toBe("!g");
});

test("opensearch endpoint uses request origin in generated templates", async ({
  request,
}) => {
  const response = await request.get("/opensearch.xml");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain(
    "application/opensearchdescription+xml"
  );

  const origin = new URL(response.url()).origin;
  const xml = await response.text();
  expect(xml).toContain(`${origin}/icon.svg`);
  expect(xml).toContain(`${origin}/?q={searchTerms}`);
  expect(xml).toContain(`${origin}/suggest?q={searchTerms}`);
});

test("suggestions include custom bang entries from the suggest cookie", async ({
  request,
}) => {
  const customBang = "mycustombang";
  const query = "!mycustom";
  const response = await request.get("/suggest", {
    params: { q: query },
    headers: {
      Cookie: `suggest=${encodeSuggestCookieValue("default", "g", "", [customBang])}`,
    },
  });
  expect(response.status()).toBe(200);

  const payload = await response.json();
  expect(payload[0]).toBe(query);
  expect(payload[1]).toContain(`!${customBang}`);
});

test("homepage bang finder supports keyboard selection", async ({ page }) => {
  await openHome(page);
  const input = page.locator("#bang-command-input");
  await expect(page.locator("#bang-command-results")).toBeHidden();
  await expect(input).toHaveCSS("border-top-width", "1px");
  await expect(input).toHaveCSS("border-top-style", "solid");

  await input.fill("github");
  const results = page.locator("#bang-command-results");
  await expect(results).toBeVisible();
  await expect(results).toContainText("!gh");
  await expect(results).toContainText("GitHub");
  await expect(input).toHaveAttribute("aria-expanded", "true");

  await input.press("Tab");
  await expect(input).toHaveAttribute(
    "aria-activedescendant",
    "bang-command-option-1"
  );
  await input.press("Shift+Tab");
  await expect(input).toHaveAttribute(
    "aria-activedescendant",
    "bang-command-option-0"
  );
  await input.press("Control+j");
  await expect(input).toHaveAttribute(
    "aria-activedescendant",
    "bang-command-option-1"
  );
  await input.press("Control+k");
  await expect(input).toHaveAttribute(
    "aria-activedescendant",
    "bang-command-option-0"
  );
  await input.press("Control+y");
  const selectedBang = page.locator("#bang-command-selected");
  await expect(selectedBang).toBeVisible();
  await expect(selectedBang).toContainText("!github");
  await expect(input).toHaveValue("");
  await expect(input).toHaveAttribute("placeholder", "Search with GitHub");
  await expect(results).toBeHidden();

  await selectedBang.click();
  await expect(selectedBang).toBeHidden();
  await input.fill("gh react");
  await expect(results).toBeHidden();

  await input.fill("github");
  await expect(results).toBeVisible();
  await input.press("Control+[");
  await expect(input).not.toBeFocused();
  await expect(results).toBeHidden();

  await page.locator("h1").click();
  await page.locator("body").press("g");
  await page.locator("body").press("i");
  await expect(input).toBeFocused();

  await page.locator("h1").click();
  await page.locator("body").press("Control+K");
  await expect(input).toBeFocused();
});

test("homepage bang finder supports suffix bang and snap selection", async ({
  page,
}) => {
  await openHome(page);
  const input = page.locator("#bang-command-input");
  const results = page.locator("#bang-command-results");
  const selectedBang = page.locator("#bang-command-selected");

  await input.fill("Hello World !");
  await expect(results).toBeVisible();
  await expect(results.locator("code").first()).toContainText("!");

  await input.fill("Hello World !gh");
  await expect(results.locator("code").first()).toHaveText("!gh");
  await input.press("Control+y");
  await expect(selectedBang).toContainText("!gh");
  await expect(input).toHaveValue("Hello World");

  await selectedBang.click();
  await input.fill("Hello World @");
  await expect(results).toBeVisible();
  await expect(results.locator("code").first()).toContainText("@");

  await input.fill("Hello World @gh");
  await expect(results.locator("code").first()).toHaveText("@gh");
  await input.press("Control+y");
  await expect(selectedBang).toContainText("@gh");
  await expect(input).toHaveValue("Hello World");
});

test("compact address-bar setup exposes browser instructions and copyable URLs", async ({
  browserName,
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText(value: string) {
          (
            window as typeof window & { copiedSetupUrl?: string }
          ).copiedSetupUrl = value;
          return Promise.resolve();
        },
      },
    });
  });
  await page.setViewportSize({ width: 390, height: 780 });
  await openHome(page);

  await expect(page.locator("#setup-url")).toHaveCount(0);
  await page.click("#open-setup");
  const modal = page.locator("#setup-modal");
  await expect(modal).toHaveAttribute("aria-hidden", "false");
  await expect(page.locator("#setup-search-url")).toHaveValue(
    `${new URL(page.url()).origin}?q=%s`
  );
  await expect(page.locator("#setup-private-search-url")).toHaveValue(
    `${new URL(page.url()).origin}/#q=%s`
  );
  const baseSuggestUrl = `${new URL(page.url()).origin}/suggest?q=%s`;
  await expect(page.locator("#setup-suggest-url")).toHaveValue(
    browserName === "firefox" ? `${baseSuggestUrl}&sp=google` : baseSuggestUrl
  );
  const expectedBrowser = {
    chromium: {
      id: "chrome",
      tab: "Chrome",
      docsHost: "support.google.com",
      settingsUrl: "chrome://settings/searchEngines",
    },
    firefox: {
      id: "firefox",
      tab: "Firefox",
      docsHost: "support.mozilla.org",
      settingsUrl: "about:preferences#search",
    },
    webkit: {
      id: "safari",
      tab: "Safari",
      docsHost: "support.apple.com",
      settingsUrl: null,
    },
  }[browserName];
  await expect(
    page.getByRole("tab", { name: expectedBrowser.tab, exact: true })
  ).toHaveAttribute("aria-selected", "true");
  const browserPanel = page.getByRole("tabpanel");
  await expect(browserPanel).toHaveAttribute(
    "aria-labelledby",
    `setup-browser-tab-${expectedBrowser.id}`
  );
  await expect(page.locator("#setup-browser-steps li")).not.toHaveCount(0);
  await expect(page.locator("#setup-browser-docs")).toHaveAttribute(
    "href",
    new RegExp(`^https://${expectedBrowser.docsHost.replaceAll(".", "\\.")}/`)
  );
  const settingsLink = page.locator("#setup-browser-steps a");
  if (expectedBrowser.settingsUrl) {
    await expect(settingsLink).toHaveAttribute(
      "href",
      expectedBrowser.settingsUrl
    );
    await settingsLink.click();
    await expect(page.getByRole("tooltip")).toBeVisible();
  } else {
    await expect(settingsLink).toHaveCount(0);
  }

  await page.getByRole("tab", { name: "Edge" }).click();
  await expect(page.locator("#setup-suggest-url")).toHaveValue(baseSuggestUrl);
  await expect(page.getByRole("tab", { name: "Edge" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(browserPanel).toHaveAttribute(
    "aria-labelledby",
    "setup-browser-tab-edge"
  );
  await expect(page.locator("#setup-browser-steps a")).toHaveAttribute(
    "href",
    "edge://settings/searchEngines"
  );
  await expect(page.locator(".setup-browser-warning")).toBeVisible();
  await expect(page.locator("#setup-browser-docs")).toHaveAttribute(
    "href",
    /^https:\/\/support\.microsoft\.com\//
  );
  await page.getByRole("tab", { name: "Edge" }).press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Firefox" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(browserPanel).toHaveAttribute(
    "aria-labelledby",
    "setup-browser-tab-firefox"
  );
  await expect(page.locator("#setup-suggest-url")).toHaveValue(
    `${baseSuggestUrl}&sp=google`
  );

  const cardBox = await page.locator("#setup-card").boundingBox();
  expect(cardBox).not.toBeNull();
  expect(cardBox!.y + cardBox!.height).toBeGreaterThan(760);

  await page.click("#copy-search-url");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { copiedSetupUrl?: string }).copiedSetupUrl
      )
    )
    .toBe(`${new URL(page.url()).origin}?q=%s`);
  await expect(page.locator("#copy-search-url [data-copy-label]")).toHaveText(
    "Copied"
  );

  await page.click("#copy-private-search-url");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { copiedSetupUrl?: string }).copiedSetupUrl
      )
    )
    .toBe(`${new URL(page.url()).origin}/#q=%s`);

  await page.keyboard.press("Escape");
  await expect(modal).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator("#open-setup")).toBeFocused();
});

test("homepage command bar executes bang commands", async ({
  browserName,
  page,
}) => {
  test.skip(
    browserName === "webkit",
    "Playwright WebKit does not support service worker lifecycle testing"
  );
  await mockGoogleSearchRoute(page);
  await ensureWarmController(page);
  await openHome(page);

  const input = page.locator("#bang-command-input");
  await input.fill("google");
  await expect(page.locator("#bang-command-results")).toBeVisible();
  await input.press("Control+y");
  await expect(page.locator("#bang-command-selected")).toContainText("!google");
  await expect(input).toHaveValue("");
  await input.pressSequentially("hello");
  await Promise.all([page.waitForURL(GOOGLE_REDIRECT), input.press("Enter")]);
  expect(page.url()).toMatch(GOOGLE_REDIRECT);
});

test("default search engine field previews and selects bangs", async ({
  page,
}) => {
  await openSettingsModal(page);
  const writeCount = await settingsWriteCount(page);

  await page.fill("#default-bang", "youtube");
  const input = page.locator("#default-bang");
  const results = page.locator("#default-bang-results");
  await expect(results).toBeVisible();
  await expect(page.locator("#bang-search")).toHaveCount(0);
  await expect(input).toHaveAttribute(
    "aria-activedescendant",
    "default-bang-option-0"
  );
  await input.press("Control+j");
  await expect(input).toHaveAttribute(
    "aria-activedescendant",
    "default-bang-option-1"
  );
  await input.press("Control+k");
  await expect(input).toHaveAttribute(
    "aria-activedescendant",
    "default-bang-option-0"
  );
  await input.press("ArrowDown");
  await expect(input).toHaveAttribute(
    "aria-activedescendant",
    "default-bang-option-1"
  );
  await input.press("ArrowUp");
  await expect(input).toHaveAttribute(
    "aria-activedescendant",
    "default-bang-option-0"
  );
  await input.press("ArrowDown");
  const activeOption = results.locator('[role="option"]').nth(1);
  const activeTrigger = await activeOption.getAttribute("data-trigger");
  const activeName = await activeOption.locator("span").first().textContent();
  expect(activeTrigger).toBeTruthy();
  expect(activeName).toBeTruthy();
  await input.press("Control+y");

  await expect(input).toHaveValue(activeTrigger!);
  await expect(page.locator("#bang-status")).toContainText(activeName!);
  await waitForSettingsWrite(page, writeCount);
});

test("user custom bangs can be selected as the default", async ({ page }) => {
  await openHome(page);
  await seedCustomBangs(page, [
    {
      trigger: "mydocs",
      name: "My Docs",
      url: "https://docs.example/search?q={}",
    },
  ]);
  await openSettingsModal(page);
  const writeCount = await settingsWriteCount(page);

  await page.fill("#default-bang", "mydocs");
  await page.dispatchEvent("#default-bang", "change");

  await expect(page.locator("#bang-status")).toHaveText("My Docs");
  await waitForSettingsWrite(page, writeCount);
});

test("capture bangs cannot be selected as the default", async ({ page }) => {
  await openHome(page);
  await seedCustomBangs(page, [
    {
      trigger: "translate",
      name: "Translate",
      url: "https://translate.example/$1/$2",
      regex: "(\\w+)\\s+(.*)",
    },
  ]);
  await openSettingsModal(page);
  const status = page.locator("#bang-status");

  await page.fill("#default-bang", "ktr");
  await page.dispatchEvent("#default-bang", "change");
  await expect(status).toHaveText("Unknown bang");

  await page.fill("#default-bang", "translate");
  await page.dispatchEvent("#default-bang", "change");
  await expect(status).toHaveText("Unknown bang");
});

test("settings invalidation applies a new default bang to redirects", async ({
  browserName,
  page,
}) => {
  await ensureWarmController(page);
  await openSettingsModal(page);

  const writeCount = await settingsWriteCount(page);
  await page.fill("#default-bang", "ddg");
  await page.dispatchEvent("#default-bang", "change");
  await waitForSettingsWrite(page, writeCount);

  await expect
    .poll(() => page.evaluate(() => document.cookie))
    .toContain(
      `suggest=${browserName === "firefox" ? "google" : "default"},ddg,`
    );

  const redirected = new URL(
    await resolveRedirectViaWorker(page, "hello", true)
  );
  expect(redirected.hostname).toBe("duckduckgo.com");
  expect(redirected.searchParams.get("q")).toBe("hello");
});

test("distinct configured prefixes replace bang, snap, lucky, and suggestion syntax", async ({
  page,
}) => {
  await ensureWarmController(page);
  await openSettingsModal(page);

  await expect(page.locator("#bang-prefix")).toHaveValue("!");
  await expect(page.locator("#snap-prefix")).toHaveValue("@");

  let writeCount = await settingsWriteCount(page);
  await page.selectOption("#bang-prefix", "$");
  await waitForSettingsWrite(page, writeCount);
  await expect(page.locator('#snap-prefix option[value="$"]')).toHaveAttribute(
    "disabled",
    ""
  );

  writeCount = await settingsWriteCount(page);
  await page.selectOption("#snap-prefix", "~");
  await waitForSettingsWrite(page, writeCount);
  await expect(page.locator('#bang-prefix option[value="~"]')).toHaveAttribute(
    "disabled",
    ""
  );
  await expect(page.locator("#default-bang-prefix")).toHaveText("$");
  await expect(page.locator("#lucky-leading-syntax")).toHaveText("$ query");
  await expect(page.locator("#lucky-trailing-syntax")).toHaveText("query $");

  await page.click("#modal-close");
  const commandInput = page.locator("#bang-command-input");
  await page.keyboard.press("$");
  await expect(commandInput).toBeFocused();
  await expect(commandInput).toHaveValue("$");
  await commandInput.fill("");
  await commandInput.evaluate((element) => element.blur());
  await page.keyboard.press("~");
  await expect(commandInput).toBeFocused();
  await expect(commandInput).toHaveValue("~");

  const bang = new URL(await resolveRedirectViaWorker(page, "$g hello", true));
  expect(bang.hostname).toBe("www.google.com");
  expect(bang.searchParams.get("q")).toBe("hello");

  const snap = new URL(await resolveRedirectViaWorker(page, "~g hello"));
  expect(snap.searchParams.get("q")).toBe("hello site:google.com");

  const replaced = new URL(await resolveRedirectViaWorker(page, "!g hello"));
  expect(replaced.searchParams.get("q")).toBe("!g hello");

  const lucky = new URL(await resolveRedirectViaWorker(page, "$ hello"));
  expect(lucky.searchParams.get("q")).toBe("hello");
  expect(lucky.searchParams.get("btnI")).toBe("1");

  const suggestCookie = (await page.context().cookies()).find(
    (cookie) => cookie.name === "suggest"
  );
  expect(suggestCookie?.value).toContain(",25");
  const suggestionResponse = await page.request.get(
    "/suggest?q=%24gh&bp=%24&np=~"
  );
  const suggestions = await suggestionResponse.json();
  expect(suggestions[1].length).toBeGreaterThan(0);
  expect(suggestions[1][0]).toMatch(/^\$g/);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.click("#gear-btn");
  await expect(page.locator("#bang-prefix")).toHaveValue("$");
  await expect(page.locator("#snap-prefix")).toHaveValue("~");
});

test("default provider labels follow the selected bang", async ({
  browserName,
  page,
}) => {
  await openSettingsModal(page);

  const luckyDefault = page.locator("#lucky-default-display");
  const suggestDefault = page.locator("#suggest-default-display");
  await expect(luckyDefault).toHaveText(/Match bang\s*Google/);
  await expect(suggestDefault).toHaveText(/Match bang\s*Google/);

  let writeCount = await settingsWriteCount(page);
  await page.fill("#default-bang", "google");
  await page.dispatchEvent("#default-bang", "change");
  await waitForSettingsWrite(page, writeCount);
  await expect(luckyDefault).toHaveText(/Match bang\s*Google/);
  await expect(suggestDefault).toHaveText(/Match bang\s*Google/);

  writeCount = await settingsWriteCount(page);
  await page.fill("#default-bang", "s");
  await page.dispatchEvent("#default-bang", "change");
  await waitForSettingsWrite(page, writeCount);
  await expect(luckyDefault).toHaveText(/Fallback\s*DuckDuckGo/);
  await expect(suggestDefault).toHaveText(/Match bang\s*Startpage/);

  writeCount = await settingsWriteCount(page);
  await page.fill("#default-bang", "w");
  await page.dispatchEvent("#default-bang", "change");
  await waitForSettingsWrite(page, writeCount);
  await expect(luckyDefault).toHaveText(/Fallback\s*DuckDuckGo/);
  await expect(suggestDefault).toHaveText(/Fallback\s*None/);

  if (browserName === "firefox") {
    return;
  }
  writeCount = await settingsWriteCount(page);
  await page.selectOption("#suggest-provider", "google");
  await waitForSettingsWrite(page, writeCount);
  await expect(suggestDefault).toBeHidden();
  writeCount = await settingsWriteCount(page);
  await page.selectOption("#suggest-provider", "default");
  await waitForSettingsWrite(page, writeCount);
  await expect(suggestDefault).toBeVisible();
});

test("settings persist suggest provider none across reload", async ({
  browserName,
  page,
  request,
}) => {
  test.skip(
    browserName === "firefox",
    "Firefox intentionally locks cookie-backed suggestion settings"
  );
  await openSettingsModal(page);

  const writeCount = await settingsWriteCount(page);
  await page.selectOption("#suggest-provider", "none");
  await waitForSettingsWrite(page, writeCount);
  if (browserName === "webkit") {
    await openHome(page);
    await page.click("#gear-btn");
    await expect(page.locator("#suggest-provider")).toHaveValue("none");
    return;
  }
  await expect
    .poll(() => page.evaluate(() => document.cookie))
    .toContain("suggest=none,");

  await openHome(page);
  const cookie = await page.evaluate(() => document.cookie);
  expect(cookie).toContain("suggest=none,");

  const response = await request.get("/suggest", {
    params: { q: "hello" },
    headers: { Cookie: cookie },
  });
  expect(response.status()).toBe(200);
  await expect(response.json()).resolves.toEqual(["hello", []]);
});

test("rapid settings changes commit in order before immediate reload", async ({
  page,
}) => {
  await openSettingsModal(page);
  const writeCount = await settingsWriteCount(page);

  const pendingState = await page.evaluate(() => {
    const select = document.querySelector("#lucky-provider");
    const status = document.querySelector("#settings-save-status");
    const spinner = document.querySelector("#settings-saving-icon");
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error("lucky provider not found");
    }
    if (!(status instanceof HTMLElement && spinner instanceof SVGElement)) {
      throw new Error("settings save indicator not found");
    }
    for (const value of ["google", "ddg", "kagi"]) {
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return {
      label: status.getAttribute("aria-label"),
      spinnerHidden: spinner.classList.contains("hidden"),
      state: status.dataset.state,
    };
  });
  expect(pendingState).toEqual({
    label: "Settings saved",
    spinnerHidden: true,
    state: "saving",
  });
  await waitForSettingsWrite(page, writeCount, 3);

  await openHome(page);
  await page.click("#gear-btn");
  await expect(page.locator("#lucky-provider")).toHaveValue("kagi");
});

test("failed settings writes stay visible until that setting succeeds", async ({
  page,
}) => {
  await openSettingsModal(page);
  await page.evaluate(() => {
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const value = args[0] as { key?: string };
      if (value?.key === "default-bang") {
        IDBObjectStore.prototype.put = originalPut;
        throw new DOMException("Injected write failure", "UnknownError");
      }
      return originalPut.apply(this, args);
    };
  });

  let writeCount = await settingsWriteCount(page);
  await page.evaluate(() => {
    const input = document.querySelector("#default-bang");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("default bang input not found");
    }
    input.value = "ddg";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await waitForSettingsWrite(page, writeCount, 1, "error");
  await expect(page.locator("#settings-save-status")).toHaveAttribute(
    "data-failed",
    "default-bang"
  );
  await expect(page.locator("#default-bang")).toHaveValue("g");

  writeCount = await settingsWriteCount(page);
  await page.selectOption("#lucky-provider", "google");
  await waitForSettingsWrite(page, writeCount, 1, "error");

  writeCount = await settingsWriteCount(page);
  await page.evaluate(() => {
    const input = document.querySelector("#default-bang");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("default bang input not found");
    }
    input.value = "ddg";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await waitForSettingsWrite(page, writeCount);
  await expect(page.locator("#default-bang")).toHaveValue("ddg");
});

test("custom providers require valid committed URL templates", async ({
  browserName,
  page,
}) => {
  test.skip(
    browserName === "firefox",
    "Firefox intentionally locks cookie-backed suggestion settings"
  );
  await openSettingsModal(page);
  const writeCount = await settingsWriteCount(page);

  await page.selectOption("#suggest-provider", "custom");
  await expect(page.locator("#settings-save-status")).toHaveAttribute(
    "data-state",
    "error"
  );
  await expect(page.locator("#suggest-provider")).toHaveValue("default");
  await expect(page.locator("#suggest-url")).toBeVisible();
  await expect(page.locator("#suggest-url")).toHaveAttribute(
    "aria-invalid",
    "true"
  );

  await page.fill("#suggest-url", "https://suggest.example/no-placeholder");
  await page.dispatchEvent("#suggest-url", "change");
  await expect(page.locator("#settings-save-status")).toHaveAttribute(
    "aria-label",
    /URL must contain \{\}/
  );
  await expect(page.locator("#settings-error-icon")).toBeVisible();
  expect(await settingsWriteCount(page)).toBe(writeCount);

  await page.selectOption("#lucky-provider", "google");
  await waitForSettingsWrite(page, writeCount, 1, "error");

  const retryCount = await settingsWriteCount(page);
  await page.fill("#suggest-url", "https://suggest.example/?q={}");
  await page.dispatchEvent("#suggest-url", "change");
  await waitForSettingsWrite(page, retryCount, 2);
  await expect(page.locator("#suggest-provider")).toHaveValue("custom");
  await expect(page.locator("#suggest-url")).not.toHaveAttribute(
    "aria-invalid"
  );
});

test("settings export includes its schema version", async ({ page }) => {
  await openSettingsModal(page);

  const downloadPromise = page.waitForEvent("download");
  await page.click("#export-btn");
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).not.toBeNull();
  const exported = JSON.parse(await readFile(path as string, "utf8"));

  expect(exported.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
  expect(exported.settings).toBeTruthy();
  expect(exported.customBangs).toEqual([]);
});

test("settings export reports malformed legacy values without changing them", async ({
  page,
}) => {
  await openHome(page);
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("flashbang", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("settings", "readwrite");
          const store = tx.objectStore("settings");
          store.put({ key: "suggest-provider", value: "custom" });
          store.put({
            key: "suggest-url",
            value: "https://suggest.example/no-placeholder",
          });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        };
      })
  );
  await openSettingsModal(page);

  await page.click("#export-btn");
  await expect(page.locator("#import-status")).toContainText(
    "Export failed: Invalid suggestion URL template"
  );
  await expect(page.locator("#suggest-url")).toHaveValue(
    "https://suggest.example/no-placeholder"
  );
});

test("invalid settings import preserves existing data", async ({ page }) => {
  await openSettingsModal(page);
  const writeCount = await settingsWriteCount(page);
  await page.fill("#default-bang", "ddg");
  await page.dispatchEvent("#default-bang", "change");
  await waitForSettingsWrite(page, writeCount);

  await page.setInputFiles("#import-file", {
    name: "empty.json",
    mimeType: "application/json",
    buffer: Buffer.from("{}"),
  });
  await expect(page.locator("#import-status")).toContainText(
    "contains no recognized data"
  );

  await openHome(page);
  await page.click("#gear-btn");
  await expect(page.locator("#default-bang")).toHaveValue("ddg");
});

test("settings import shows a summary and requires confirmation", async ({
  page,
}) => {
  await openSettingsModal(page);
  await page.fill('input[name="shortcut"]', "oldimport");
  await page.fill('input[name="name"]', "Old Import");
  await page.fill('input[name="url"]', "https://example.com/old?q={}");
  await submitCustomBangForm(page);
  const payload = {
    schemaVersion: 1,
    settings: {
      defaultBang: "ddg",
      suggestProvider: "custom",
      suggestUrl: "https://suggest.example/?q={}",
      luckyProvider: "custom",
      luckyUrl: "https://lucky.example/?q={}",
    },
    customBangs: [
      {
        trigger: "validimport",
        name: "Valid Import",
        url: "https://example.com/import?q={}",
      },
      {
        trigger: "badimport",
        name: "Bad Import",
        url: "https://example.com/no-placeholder",
      },
    ],
  };
  const file = {
    name: "settings.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(payload)),
  };

  let confirmation = "";
  await Promise.all([
    page.waitForEvent("dialog").then(async (dialog) => {
      confirmation = dialog.message();
      await dialog.dismiss();
    }),
    page.setInputFiles("#import-file", file),
  ]);
  expect(confirmation).toContain("Replace current settings?");
  expect(confirmation).toContain(
    "5 settings, 1 custom bangs accepted, 1 rejected"
  );
  await expect(page.locator("#import-status")).toContainText("Import canceled");

  const writeCount = await settingsWriteCount(page);
  await Promise.all([
    page.waitForEvent("dialog").then((dialog) => dialog.accept()),
    page.setInputFiles("#import-file", file),
  ]);
  await waitForSettingsWrite(page, writeCount);
  await expect(page.locator("#import-status")).toHaveText(
    "Imported: 5 settings, 1 custom bangs accepted, 1 rejected"
  );
  await expect(page.locator("#default-bang")).toHaveValue("ddg");
  await expect(page.locator("#lucky-provider")).toHaveValue("custom");
  await expect(page.locator("#lucky-url")).toHaveValue(
    "https://lucky.example/?q={}"
  );
  await expect(page.locator("#lucky-url")).toBeVisible();
  await expect(page.locator("#custom-list")).toContainText("!validimport");
  await expect(page.locator("#custom-list")).not.toContainText("!oldimport");
  if (test.info().project.name !== "firefox") {
    await expect(page.locator("#suggest-provider")).toHaveValue("custom");
    await expect(page.locator("#suggest-url")).toBeVisible();
  }

  await openHome(page);
  await page.click("#gear-btn");
  await expect(page.locator("#default-bang")).toHaveValue("ddg");
  await expect(page.locator("#custom-list")).toContainText("!validimport");
  await expect(page.locator("#custom-list")).not.toContainText("!badimport");
});

test("settings persist custom bang creation across reload", async ({
  browserName,
  page,
}) => {
  await mockCustomHostRoute(page);
  if (browserName !== "webkit") {
    await ensureWarmController(page);
  }
  await openSettingsModal(page);

  await page.fill('input[name="shortcut"]', "mydocs");
  await page.fill('input[name="name"]', "My Docs");
  await page.fill('input[name="url"]', `${CUSTOM_HOST}/search?q={}`);
  await submitCustomBangForm(page);
  await expect(page.locator("#custom-list")).toContainText("!mydocs");

  await openHome(page);
  await page.click("#gear-btn");
  await expect(page.locator("#custom-list")).toContainText("!mydocs");

  if (browserName === "webkit") {
    return;
  }
  await ensureWarmController(page);
  await navigateAndWaitForRedirect(
    page,
    "/?q=%21mydocs%20hello",
    /example\.com\/search\?q=hello/
  );

  const redirected = new URL(page.url());
  expect(redirected.hostname).toBe("example.com");
  expect(redirected.pathname).toBe("/search");
  expect(redirected.searchParams.get("q")).toBe("hello");
});

test("settings reject invalid custom bang URL format", async ({ page }) => {
  await openSettingsModal(page);
  await expect(page.locator("#custom-list")).toContainText(
    "No custom bangs yet"
  );

  await page.fill('input[name="shortcut"]', "bad");
  await page.fill('input[name="name"]', "Bad");
  await page.fill('input[name="url"]', "https://example.com/search");
  await submitCustomBangForm(page, false);

  await expect(page.locator("#custom-list")).toContainText(
    "No custom bangs yet"
  );
});

test("settings create and execute a custom capture bang", async ({ page }) => {
  await mockCustomHostRoute(page);
  await ensureWarmController(page);
  await openSettingsModal(page);

  await page.fill('input[name="shortcut"]', "trurl");
  await page.fill('input[name="name"]', "Translate URL");
  await page.fill('input[name="url"]', `${CUSTOM_HOST}/translate/$1?target=$2`);
  await page.locator("#add-bang-form details summary").click();
  await page.fill('input[name="regex"]', "(\\w+)\\s+(.*)");
  await page.selectOption('select[name="encoding"]', "percent");
  await submitCustomBangForm(page);
  await expect(page.locator("#custom-list")).toContainText("!trurl");
  await expect(page.locator("#custom-list")).toContainText("regex");

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await ensureWarmController(page);
  await navigateAndWaitForRedirect(
    page,
    "/?q=%21trurl%20ja%20https%3A%2F%2Fexample.org%2Farticle",
    /example\.com\/translate\/ja/
  );
  const redirected = new URL(page.url());
  expect(redirected.pathname).toBe("/translate/ja");
  expect(redirected.searchParams.get("target")).toBe(
    "https://example.org/article"
  );
});

test("settings create and execute a custom snap target", async ({ page }) => {
  await mockGoogleSearchRoute(page);
  await openSettingsModal(page);

  await page.fill('input[name="shortcut"]', "snapdocs");
  await page.fill('input[name="name"]', "Snap Docs");
  await page.fill('input[name="url"]', `${CUSTOM_HOST}/search?q={}`);
  await page.locator("#add-bang-form details summary").click();
  await page.fill('input[name="snap"]', "example.com/docs");
  await submitCustomBangForm(page);
  await expect(page.locator("#custom-list")).toContainText("!snapdocs");
  await expect(page.locator("#custom-list")).toContainText("snap");

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await ensureWarmController(page);
  await navigateAndWaitForRedirect(
    page,
    "/?q=%40snapdocs%20arrays",
    /google\.com\/search/
  );
  const redirected = new URL(page.url());
  expect(redirected.searchParams.get("q")).toBe("arrays site:example.com/docs");
});

test("settings edit and rename an existing custom bang", async ({ page }) => {
  await mockCustomHostRoute(page);
  await mockGoogleSearchRoute(page);
  await ensureWarmController(page);
  await seedCustomBangs(page, [
    {
      trigger: "before",
      name: "Before",
      url: `${CUSTOM_HOST}/before?q={}`,
      snap: "example.com/before",
    },
  ]);
  await openSettingsModal(page);

  const row = page.locator("#custom-list").filter({ hasText: "!before" });
  await row.getByRole("button", { name: "edit" }).click();
  await expect(page.locator('input[name="shortcut"]')).toHaveValue("before");
  await expect(page.locator('input[name="name"]')).toHaveValue("Before");
  await expect(page.locator('input[name="url"]')).toHaveValue(
    `${CUSTOM_HOST}/before?q={}`
  );
  await expect(page.locator('input[name="snap"]')).toHaveValue(
    "example.com/before"
  );
  await expect(page.locator("#add-bang-form details")).toHaveAttribute(
    "open",
    ""
  );
  await expect(page.locator("#custom-bang-submit")).toHaveText("Save Changes");
  await expect(page.locator("#custom-bang-cancel")).toBeVisible();

  await page.fill('input[name="name"]', "Discarded");
  await page.click("#custom-bang-cancel");
  await expect(page.locator('input[name="shortcut"]')).toHaveValue("");
  await expect(page.locator("#custom-bang-submit")).toHaveText("Add Bang");
  await expect(page.locator("#custom-bang-cancel")).toBeHidden();
  await expect(page.locator("#custom-list")).toContainText("Before");

  await row.getByRole("button", { name: "edit" }).click();
  await page.fill('input[name="shortcut"]', "after");
  await page.fill('input[name="name"]', "After");
  await page.fill('input[name="url"]', `${CUSTOM_HOST}/after?q={}`);
  await page.fill('input[name="snap"]', "example.com/after");
  await submitCustomBangForm(page);

  await expect(page.locator("#custom-list")).toContainText("!after");
  await expect(page.locator("#custom-list")).not.toContainText("!before");
  await expect(page.locator("#custom-bang-submit")).toHaveText("Add Bang");
  await expect(page.locator("#custom-bang-cancel")).toBeHidden();

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await ensureWarmController(page);
  await navigateAndWaitForRedirect(
    page,
    "/?q=%40after%20updated",
    /google\.com\/search/
  );
  expect(new URL(page.url()).searchParams.get("q")).toBe(
    "updated site:example.com/after"
  );
});

test("settings persist custom lucky URL across reload", async ({ page }) => {
  await mockCustomHostRoute(page);
  await ensureWarmController(page);
  await openSettingsModal(page);

  const writeCount = await settingsWriteCount(page);
  await page.selectOption("#lucky-provider", "custom");
  await expect(page.locator("#settings-save-status")).toHaveAttribute(
    "data-state",
    "error"
  );
  await expect(page.locator("#lucky-url")).toBeVisible();
  await page.fill("#lucky-url", `${CUSTOM_HOST}/lucky?q={}`);
  await page.dispatchEvent("#lucky-url", "change");
  await waitForSettingsWrite(page, writeCount, 2);
  await expect(page.locator("#lucky-provider")).toHaveValue("custom");

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await ensureWarmController(page);
  await navigateAndWaitForRedirect(
    page,
    "/?q=hello%20%21",
    /example\.com\/lucky\?q=hello/
  );

  const redirected = new URL(page.url());
  expect(redirected.hostname).toBe("example.com");
  expect(redirected.pathname).toBe("/lucky");
  expect(redirected.searchParams.get("q")).toBe("hello");
});

test("warm redirect uses service worker controlled fetch path", async ({
  page,
}) => {
  await mockGoogleSearchRoute(page);
  await ensureWarmController(page);
  await navigateAndWaitForRedirect(page, "/?q=%21g%20hello", GOOGLE_REDIRECT);
  expect(page.url()).toMatch(GOOGLE_REDIRECT);
});

test("warm redirect supports suffix bang syntax", async ({ page }) => {
  await mockGoogleSearchRoute(page);
  await ensureWarmController(page);
  await navigateAndWaitForRedirect(page, "/?q=hello%20g%21", GOOGLE_REDIRECT);
  const redirected = new URL(page.url());
  expect(redirected.searchParams.get("q")).toBe("hello");
});

test("warm redirect falls back to default search for unknown bangs", async ({
  page,
}) => {
  await mockGoogleSearchRoute(page);
  await ensureWarmController(page);
  await navigateAndWaitForRedirect(
    page,
    "/?q=%21zzzb%20hello",
    /google\.com\/search\?/
  );
  const redirected = new URL(page.url());
  expect(redirected.hostname).toBe("www.google.com");
  expect(redirected.pathname).toBe("/search");
  expect(redirected.searchParams.get("q")).toBe("!zzzb hello");
});

test("warm redirect uses lucky URL for trailing bare bang", async ({
  page,
}) => {
  await ensureWarmController(page);
  await openHome(page);
  const resolved = await resolveRedirectViaWorker(page, "hello !");
  const redirected = new URL(resolved);
  expect(redirected.hostname).toBe("www.google.com");
  expect(redirected.pathname).toBe("/search");
  expect(redirected.searchParams.get("q")).toBe("hello");
  expect(redirected.searchParams.get("btnI")).toBe("1");
});

test("custom bang redirects to custom target", async ({ page }) => {
  await mockCustomHostRoute(page);
  await ensureWarmController(page);
  await seedCustomBangs(page, [
    {
      trigger: "mydocs",
      name: "My Docs",
      url: `${CUSTOM_HOST}/search?q={}`,
    },
  ]);

  await navigateAndWaitForRedirect(
    page,
    "/?q=%21mydocs%20hello",
    /example\.com\/search\?q=hello/
  );
  const redirected = new URL(page.url());
  expect(redirected.hostname).toBe("example.com");
  expect(redirected.pathname).toBe("/search");
  expect(redirected.searchParams.get("q")).toBe("hello");
});

test("custom bang overrides built-in bang trigger", async ({ page }) => {
  await mockGoogleSearchRoute(page);
  await mockCustomHostRoute(page);
  await ensureWarmController(page);
  await seedCustomBangs(page, [
    {
      trigger: "g",
      name: "Custom G",
      url: `${CUSTOM_HOST}/override?q={}`,
    },
  ]);

  await navigateAndWaitForRedirect(
    page,
    "/?q=%21g%20hello",
    /example\.com\/override\?q=hello/
  );
  const redirected = new URL(page.url());
  expect(redirected.hostname).toBe("example.com");
  expect(redirected.pathname).toBe("/override");
  expect(redirected.searchParams.get("q")).toBe("hello");
});

test("custom bang with no term redirects to custom origin", async ({
  page,
}) => {
  await mockCustomHostRoute(page);
  await ensureWarmController(page);
  await seedCustomBangs(page, [
    {
      trigger: "mydocs",
      name: "My Docs",
      url: `${CUSTOM_HOST}/search?q={}`,
    },
  ]);

  await navigateAndWaitForRedirect(page, "/?q=%21mydocs", /example\.com/);
  const redirected = new URL(page.url());
  expect(redirected.origin).toBe(CUSTOM_HOST);
});

test("custom bang supports suffix syntax", async ({ page }) => {
  await mockCustomHostRoute(page);
  await ensureWarmController(page);
  await seedCustomBangs(page, [
    {
      trigger: "mydocs",
      name: "My Docs",
      url: `${CUSTOM_HOST}/search?q={}`,
    },
  ]);

  await navigateAndWaitForRedirect(
    page,
    "/?q=hello%20mydocs%21",
    /example\.com\/search\?q=hello/
  );
  const redirected = new URL(page.url());
  expect(redirected.hostname).toBe("example.com");
  expect(redirected.searchParams.get("q")).toBe("hello");
});

test("custom bang persists after reload in the same context", async ({
  page,
}) => {
  await mockCustomHostRoute(page);
  await ensureWarmController(page);
  await seedCustomBangs(page, [
    {
      trigger: "mydocs",
      name: "My Docs",
      url: `${CUSTOM_HOST}/search?q={}`,
    },
  ]);

  await navigateAndWaitForRedirect(
    page,
    "/?q=%21mydocs%20first",
    /example\.com\/search\?q=first/
  );
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await ensureWarmController(page);
  await navigateAndWaitForRedirect(
    page,
    "/?q=%21mydocs%20second",
    /example\.com\/search\?q=second/
  );
  const redirected = new URL(page.url());
  expect(redirected.searchParams.get("q")).toBe("second");
});

test("first installation redirects before a controller exists", async ({
  browser,
  browserName,
}) => {
  test.skip(
    browserName === "webkit",
    "Playwright WebKit does not support service worker lifecycle testing"
  );
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await mockGoogleSearchRoute(page);

    await page.goto("/health", { waitUntil: "domcontentloaded" });
    expect(
      await page.evaluate(() => {
        if (!("serviceWorker" in navigator)) {
          return null;
        }
        return navigator.serviceWorker.controller;
      })
    ).toBeNull();

    const target = "/?q=%21g%20hello";
    await Promise.all([
      page.waitForURL(/google\.com\/search\?q=hello/),
      page.goto(target, { waitUntil: "commit" }),
    ]);
    expect(await page.url()).toMatch(GOOGLE_REDIRECT);
  } finally {
    await context.close();
  }
});

test("first fallback seeds the worker for the next offline redirect", async ({
  browser,
  browserName,
}) => {
  test.skip(
    browserName === "webkit",
    "Playwright WebKit does not support service worker lifecycle testing"
  );
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await mockGoogleSearchRoute(page);
    const bangDataRequests: string[] = [];
    context.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (
        pathname === "/bangs.bin" ||
        (pathname.startsWith("/bangs-") && !pathname.startsWith("/bangs-meta-"))
      ) {
        bangDataRequests.push(pathname);
      }
    });

    await page.goto("/health");
    await navigateAndWaitForRedirect(
      page,
      "/?q=%21g%20first",
      /google\.com\/search\?q=first/
    );

    const probe = await context.newPage();
    await mockGoogleSearchRoute(probe);
    await probe.goto("/health");
    await probe.waitForFunction(
      () =>
        "serviceWorker" in navigator &&
        navigator.serviceWorker.controller !== null
    );
    await expect
      .poll(() =>
        probe.evaluate(async () => {
          for (const cacheName of await caches.keys()) {
            const requests = await (await caches.open(cacheName)).keys();
            if (
              requests.some(({ url }) => {
                const pathname = new URL(url).pathname;
                return (
                  pathname === "/bangs.bin" ||
                  (pathname.startsWith("/bangs-") &&
                    !pathname.startsWith("/bangs-meta-"))
                );
              })
            ) {
              return true;
            }
          }
          return false;
        })
      )
      .toBe(true);
    expect(bangDataRequests).toHaveLength(1);

    const origin = new URL(probe.url()).origin;
    await context.route(`${origin}/**`, (route) => route.abort());
    try {
      await navigateAndWaitForRedirect(
        probe,
        "/?q=%21g%20second",
        /google\.com\/search\?q=second/
      );
    } finally {
      await context.unroute(`${origin}/**`);
    }
  } finally {
    await context.close();
  }
});

test("private hash redirect keeps the query out of origin requests", async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      Reflect.deleteProperty(Navigator.prototype, "serviceWorker");
    });
    await mockGoogleSearchRoute(page);
    await page.goto("/health");
    const origin = new URL(page.url()).origin;
    const originRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().startsWith(origin)) {
        originRequests.push(request.url());
      }
    });

    await navigateAndWaitForRedirect(page, "/#q=%21g%20hello", GOOGLE_REDIRECT);
    expect(originRequests.length).toBeGreaterThan(0);
    expect(originRequests.every((url) => !url.includes("hello"))).toBe(true);
    expect(
      originRequests.some((url) =>
        ["/app.js", "/home"].includes(new URL(url).pathname)
      )
    ).toBe(false);
    expect(new URL(page.url()).hash).toBe("");
  } finally {
    await context.close();
  }
});

test("private hash redirect works from a controlled homepage", async ({
  page,
}) => {
  await mockGoogleSearchRoute(page);
  await ensureWarmController(page);
  await openHome(page);
  const origin = new URL(page.url()).origin;
  const originRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith(origin)) {
      originRequests.push(request.url());
    }
  });

  await navigateAndWaitForRedirect(page, "/#q=%21g%20hello", GOOGLE_REDIRECT);
  expect(originRequests.every((url) => !url.includes("hello"))).toBe(true);
  expect(
    originRequests.some((url) =>
      ["/app.js", "/home"].includes(new URL(url).pathname)
    )
  ).toBe(false);
  expect(new URL(page.url()).hash).toBe("");
});

test("redirect falls back when service workers are unavailable", async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      Reflect.deleteProperty(Navigator.prototype, "serviceWorker");
    });
    await mockGoogleSearchRoute(page);

    expect(
      await page
        .goto("/health")
        .then(() => page.evaluate(() => "serviceWorker" in navigator))
    ).toBe(false);
    await page.goto("/");
    await expect(page).toHaveURL(/\/home$/);
    await expect(page.locator("#gear-btn")).toBeVisible();
    await navigateAndWaitForRedirect(page, "/?q=%21g%20hello", GOOGLE_REDIRECT);
    expect(page.url()).toMatch(GOOGLE_REDIRECT);
  } finally {
    await context.close();
  }
});

test("redirect falls back when service workers are unavailable during registration", async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator.serviceWorker, "register", {
        configurable: true,
        value: () =>
          Promise.reject(
            new DOMException("Service Workers blocked", "SecurityError")
          ),
      });
    });
    await mockGoogleSearchRoute(page);

    await navigateAndWaitForRedirect(page, "/?q=%21g%20hello", GOOGLE_REDIRECT);
    expect(page.url()).toMatch(GOOGLE_REDIRECT);
  } finally {
    await context.close();
  }
});

test("redirect survives a service worker restart", async ({
  browser,
  browserName,
  page,
}) => {
  test.skip(
    browserName !== "chromium",
    "Playwright only exposes service worker handles in Chromium"
  );
  await mockGoogleSearchRoute(page);
  await ensureWarmController(page);

  const cdp = await browser.newBrowserCDPSession();
  const { targetInfos } = await cdp.send("Target.getTargets");
  const workerTarget = targetInfos.find(
    (target) =>
      target.type === "service_worker" && target.url.endsWith("/sw.js")
  );
  expect(workerTarget).toBeDefined();
  await cdp.send("Target.closeTarget", { targetId: workerTarget!.targetId });

  await navigateAndWaitForRedirect(page, "/?q=%21g%20hello", GOOGLE_REDIRECT);
  expect(page.url()).toMatch(GOOGLE_REDIRECT);
});

test("controlled redirect works while offline", async ({
  browserName,
  context,
  page,
}) => {
  test.skip(
    browserName === "webkit",
    "Playwright WebKit does not support service worker lifecycle testing"
  );
  await mockGoogleSearchRoute(page);
  await ensureWarmController(page);
  const origin = new URL(page.url()).origin;
  await context.route(`${origin}/**`, (route) => route.abort());
  try {
    await navigateAndWaitForRedirect(page, "/?q=%21g%20hello", GOOGLE_REDIRECT);
  } finally {
    await context.unroute(`${origin}/**`);
  }
});

test("settings catalog works on its first offline open", async ({
  browserName,
  context,
  page,
}) => {
  test.skip(
    browserName === "webkit",
    "Playwright WebKit does not support service worker lifecycle testing"
  );
  await ensureWarmController(page);

  await context.setOffline(true);
  try {
    await openSettingsModal(page);
    await page.fill("#default-bang", "youtube");
    await expect(page.locator("#default-bang-results")).toBeVisible();
    await expect(
      page.locator('#default-bang-results [data-trigger="youtube"]')
    ).toContainText("YouTube");
  } finally {
    await context.setOffline(false);
  }
});

test("redirect falls back safely when IndexedDB cannot be opened", async ({
  browser,
  browserName,
}) => {
  test.skip(
    browserName === "webkit",
    "Playwright WebKit does not support service worker lifecycle testing"
  );
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await mockGoogleSearchRoute(page);
    await page.goto("/health");
    await page.evaluate(
      (version) =>
        new Promise<void>((resolve, reject) => {
          const request = indexedDB.open("flashbang", version);
          request.onsuccess = () => {
            request.result.close();
            resolve();
          };
          request.onerror = () => reject(request.error);
        }),
      DB_VERSION + 1
    );

    await navigateAndWaitForRedirect(page, "/?q=hello", GOOGLE_REDIRECT);
    expect(page.url()).toMatch(GOOGLE_REDIRECT);
  } finally {
    await context.close();
  }
});

test("worker activation creates its cache and removes the old cache", async ({
  browserName,
  context,
  page,
}) => {
  test.skip(
    browserName !== "chromium",
    "Service worker cache lifecycle coverage runs in Chromium"
  );
  const workerSource = await readFile(
    `${process.env.DIST_DIR || "dist"}/sw.js`,
    "utf8"
  );
  const indexSource = await readFile(
    `${process.env.DIST_DIR || "dist"}/index.html`,
    "utf8"
  );
  const builtCacheName = workerSource.match(/fb-[a-f0-9]{8}/)?.[0];
  const builtBangDataAsset = workerSource.match(
    /\/bangs-[a-f0-9]{12}\.bin/
  )?.[0];
  const builtBangMetaAsset = workerSource.match(
    /\/bangs-meta-[a-f0-9]{12}\.bin/
  )?.[0];
  expect(builtCacheName).toBeDefined();
  expect(builtBangDataAsset).toBeDefined();
  expect(builtBangMetaAsset).toBeDefined();
  expect(indexSource).toContain(builtBangDataAsset!);
  const initialCacheName = "fb-e2e-initial";
  const lifecyclePage = await context.newPage();
  await lifecyclePage.goto("/health");
  await lifecyclePage.evaluate(
    (cacheName) => caches.open(cacheName),
    initialCacheName
  );
  await expect
    .poll(() => lifecyclePage.evaluate(() => caches.keys()))
    .toContain(initialCacheName);

  await ensureWarmController(page);
  await expect
    .poll(() => lifecyclePage.evaluate(() => caches.keys()))
    .toContain(builtCacheName!);
  await expect
    .poll(() =>
      lifecyclePage.evaluate(
        async ({ assetPath, cacheName }) => {
          const cache = await caches.open(cacheName);
          return Boolean(await cache.match(assetPath));
        },
        { cacheName: builtCacheName!, assetPath: builtBangDataAsset! }
      )
    )
    .toBe(true);
  await expect
    .poll(() =>
      lifecyclePage.evaluate(
        async ({ assetPath, cacheName }) => {
          const cache = await caches.open(cacheName);
          return Boolean(await cache.match(assetPath));
        },
        { cacheName: builtCacheName!, assetPath: builtBangMetaAsset! }
      )
    )
    .toBe(true);
  await expect
    .poll(() => lifecyclePage.evaluate(() => caches.keys()))
    .not.toContain(initialCacheName);
});
