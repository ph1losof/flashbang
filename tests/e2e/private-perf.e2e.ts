import { type Page, test } from "@playwright/test";

const GOOGLE = "https://www.google.com";
const COLD_RUNS = Number(process.env.PROFILE_COLD_RUNS ?? 12);
const WARM_RUNS = Number(process.env.PROFILE_WARM_RUNS ?? 30);
const NETWORK_DELAY_MS = Math.max(
  0,
  Number(process.env.PROFILE_NETWORK_DELAY_MS) || 0
);
const BANG_DATA_DELAY_MS = Math.max(
  0,
  Number(process.env.PROFILE_BANG_DATA_DELAY_MS) || 0
);
const IDB_OPEN_DELAY_MS = Math.max(
  0,
  Number(process.env.PROFILE_IDB_OPEN_DELAY_MS) || 0
);

interface Timing {
  bangDataRequests: number;
  elapsed: number;
  fallbackRequested: boolean;
}

function percentile(values: readonly number[], fraction: number): number {
  return values[
    Math.min(values.length - 1, Math.floor(values.length * fraction))
  ];
}

function summarize(samples: readonly Timing[]) {
  const values = samples.map((sample) => sample.elapsed).sort((a, b) => a - b);
  return {
    median: percentile(values, 0.5).toFixed(2),
    p95: percentile(values, 0.95).toFixed(2),
    min: values[0].toFixed(2),
    max: values.at(-1)!.toFixed(2),
    bangDataRequests: samples.reduce(
      (total, sample) => total + sample.bangDataRequests,
      0
    ),
    fallbacks: samples.filter((sample) => sample.fallbackRequested).length,
  };
}

async function mockGoogle(page: Page): Promise<void> {
  await page.context().route(`${GOOGLE}/**`, (route) => {
    route.fulfill({ status: 200, contentType: "text/plain", body: "ok" });
  });
}

async function conditionColdNetwork(
  page: Page,
  baseURL: string
): Promise<void> {
  if (NETWORK_DELAY_MS === 0 && BANG_DATA_DELAY_MS === 0) {
    return;
  }
  const origin = new URL(baseURL).origin;
  await page.context().route(`${origin}/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const bangDataDelay =
      pathname === "/bangs.bin" ||
      (pathname.startsWith("/bangs-") && !pathname.startsWith("/bangs-meta-"))
        ? BANG_DATA_DELAY_MS
        : 0;
    await new Promise((resolve) =>
      setTimeout(resolve, NETWORK_DELAY_MS + bangDataDelay)
    );
    await route.continue();
  });
}

async function conditionIdbOpen(page: Page): Promise<void> {
  if (IDB_OPEN_DELAY_MS === 0) {
    return;
  }
  await page.addInitScript((delay) => {
    const originalOpen = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function delayedOpen(
      name: string,
      version?: number
    ): IDBOpenDBRequest {
      const request =
        version === undefined
          ? originalOpen.call(this, name)
          : originalOpen.call(this, name, version);
      return new Proxy(request, {
        get(target, property) {
          return Reflect.get(target, property, target);
        },
        set(target, property, value) {
          if (property === "onsuccess" && typeof value === "function") {
            return Reflect.set(
              target,
              property,
              (event: Event) => {
                setTimeout(() => value.call(target, event), delay);
              },
              target
            );
          }
          return Reflect.set(target, property, value, target);
        },
      });
    };
  }, IDB_OPEN_DELAY_MS);
}

async function waitForSeededRuntime(page: Page): Promise<void> {
  await page.goto("/health");
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) {
      return;
    }
    registration.active?.postMessage({ type: "claim" });
    await new Promise<void>((resolve) => {
      navigator.serviceWorker.addEventListener(
        "controllerchange",
        () => resolve(),
        {
          once: true,
        }
      );
    });
  });
  await page.waitForFunction(async () => {
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
  });
}

async function measure(
  page: Page,
  path = "/#q=%21g%20profile"
): Promise<Timing> {
  let bangDataRequests = 0;
  let fallbackRequested = false;
  let resolveTarget!: (timing: Timing) => void;
  const target = new Promise<Timing>((resolve) => {
    resolveTarget = resolve;
  });
  const started = performance.now();
  const listener = (request: { url(): string }) => {
    const pathname = new URL(request.url()).pathname;
    if (
      pathname === "/bangs.bin" ||
      (pathname.startsWith("/bangs-") && !pathname.startsWith("/bangs-meta-"))
    ) {
      bangDataRequests++;
    }
    if (pathname === "/fallback.js" || pathname.startsWith("/fallback-")) {
      fallbackRequested = true;
    }
    if (request.url().startsWith(`${GOOGLE}/search?`)) {
      resolveTarget({
        bangDataRequests,
        elapsed: performance.now() - started,
        fallbackRequested,
      });
    }
  };
  page.on("request", listener);
  const navigation = page.goto(path, { waitUntil: "commit" }).catch(() => null);
  const timing = await target;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (page.url().startsWith(GOOGLE)) {
      break;
    }
    await page.waitForTimeout(5);
  }
  await navigation;
  page.off("request", listener);
  return timing;
}

test("private hash redirect and public path performance profile", async ({
  baseURL,
  browser,
  browserName,
}) => {
  test.skip(
    process.env.PROFILE_PRIVATE_REDIRECT !== "true",
    "Run with PROFILE_PRIVATE_REDIRECT=true"
  );
  test.setTimeout(120_000);
  if (!baseURL) {
    throw new Error("Private redirect profile requires a configured baseURL");
  }

  const cold: Timing[] = [];
  for (let i = 0; i < COLD_RUNS; i++) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await conditionIdbOpen(page);
    await page.addInitScript(() => {
      Reflect.deleteProperty(Navigator.prototype, "serviceWorker");
    });
    await conditionColdNetwork(page, baseURL);
    await mockGoogle(page);
    cold.push(await measure(page));
    await context.close();
  }

  const fallbackWarmContext = await browser.newContext();
  const fallbackWarmPage = await fallbackWarmContext.newPage();
  await conditionIdbOpen(fallbackWarmPage);
  await fallbackWarmPage.addInitScript(() => {
    Reflect.deleteProperty(Navigator.prototype, "serviceWorker");
  });
  await mockGoogle(fallbackWarmPage);
  await measure(fallbackWarmPage);
  const fallbackWarm: Timing[] = [];
  for (let i = 0; i < WARM_RUNS; i++) {
    fallbackWarm.push(await measure(fallbackWarmPage));
  }
  await fallbackWarmContext.close();

  const firstInstall: Timing[] = [];
  const postInstall: Timing[] = [];
  for (let i = 0; i < COLD_RUNS; i++) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await conditionIdbOpen(page);
    await conditionColdNetwork(page, baseURL);
    await mockGoogle(page);
    firstInstall.push(await measure(page));
    await waitForSeededRuntime(page);
    postInstall.push(await measure(page));
    await context.close();
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  await mockGoogle(page);
  await page.goto("/");
  await page.waitForFunction(
    () =>
      "serviceWorker" in navigator &&
      navigator.serviceWorker.controller !== null
  );
  await page.goto("/").catch(() => null);
  await page.waitForSelector("#gear-btn");
  await measure(page);
  const warm: Timing[] = [];
  const publicWarm: Timing[] = [];
  for (let i = 0; i < WARM_RUNS; i++) {
    if ((i & 1) === 0) {
      publicWarm.push(await measure(page, "/?q=%21g%20profile"));
      warm.push(await measure(page));
    } else {
      warm.push(await measure(page));
      publicWarm.push(await measure(page, "/?q=%21g%20profile"));
    }
  }
  await context.close();

  const workerRestart: Timing[] = [];
  const bundleFallback: Timing[] = [];
  if (browserName === "chromium") {
    const restartContext = await browser.newContext();
    const restartPage = await restartContext.newPage();
    await conditionIdbOpen(restartPage);
    await mockGoogle(restartPage);
    await conditionColdNetwork(restartPage, baseURL);
    await restartPage.goto("/");
    await restartPage.waitForFunction(
      () => navigator.serviceWorker.controller !== null
    );
    await restartPage.waitForFunction(
      () =>
        new Promise<boolean>((resolve) => {
          const open = indexedDB.open("flashbang", 1);
          open.onerror = () => resolve(false);
          open.onsuccess = () => {
            const db = open.result;
            const request = db
              .transaction("settings", "readonly")
              .objectStore("settings")
              .get("redirect-settings-snapshot");
            request.onerror = () => {
              db.close();
              resolve(false);
            };
            request.onsuccess = () => {
              const value = request.result as
                | { catalogVersion?: unknown; version?: unknown }
                | undefined;
              db.close();
              resolve(
                value?.version === 2 &&
                  typeof value.catalogVersion === "string" &&
                  value.catalogVersion.length > 0
              );
            };
          };
        })
    );
    const cdp = await browser.newBrowserCDPSession();
    const workerUrl = new URL("/sw.js", baseURL).href;

    const closeWorker = async () => {
      const { targetInfos } = await cdp.send("Target.getTargets");
      const worker = targetInfos.find(
        (target) => target.type === "service_worker" && target.url === workerUrl
      );
      if (!worker) {
        throw new Error("Service Worker target missing from restart profile");
      }
      await cdp.send("Target.closeTarget", { targetId: worker.targetId });
    };

    for (let i = 0; i < COLD_RUNS; i++) {
      await closeWorker();
      workerRestart.push(await measure(restartPage, "/?q=%21g%20profile"));
    }

    for (let i = 0; i < COLD_RUNS; i++) {
      await restartPage.goto("/health");
      await restartPage.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;
        await registration.navigationPreload.setHeaderValue("invalid");
        await registration.navigationPreload.disable();
        for (const cacheName of await caches.keys()) {
          const cache = await caches.open(cacheName);
          for (const request of await cache.keys()) {
            const pathname = new URL(request.url).pathname;
            if (
              pathname === "/bangs.bin" ||
              (pathname.startsWith("/bangs-") &&
                !pathname.startsWith("/bangs-meta-"))
            ) {
              await cache.delete(request);
            }
          }
        }
      });
      await closeWorker();
      bundleFallback.push(await measure(restartPage, "/?q=profile"));
      await waitForSeededRuntime(restartPage);
    }
    await cdp.detach();
    await restartContext.close();
  }

  const floorContext = await browser.newContext();
  const floorPage = await floorContext.newPage();
  await floorPage.addInitScript(() => {
    Reflect.deleteProperty(Navigator.prototype, "serviceWorker");
  });
  await mockGoogle(floorPage);
  await floorPage.goto("/health");
  const rootUrl = new URL("/", floorPage.url()).href;
  await floorContext.route(rootUrl, (route) => {
    route.fulfill({
      body: `<script>location.replace("${GOOGLE}/search?q=profile")</script>`,
      contentType: "text/html",
      status: 200,
    });
  });
  const documentFloor: Timing[] = [];
  for (let i = 0; i < WARM_RUNS; i++) {
    documentFloor.push(await measure(floorPage));
  }
  await floorContext.close();

  console.log(
    JSON.stringify({
      browserName,
      bangDataDelayMs: BANG_DATA_DELAY_MS,
      ...(bundleFallback.length > 0
        ? { bundleFallback: summarize(bundleFallback) }
        : {}),
      cold: summarize(cold),
      controlledWarm: summarize(warm),
      documentFloor: summarize(documentFloor),
      fallbackWarm: summarize(fallbackWarm),
      firstInstall: summarize(firstInstall),
      idbOpenDelayMs: IDB_OPEN_DELAY_MS,
      networkDelayMs: NETWORK_DELAY_MS,
      postInstall: summarize(postInstall),
      publicWarm: summarize(publicWarm),
      ...(workerRestart.length > 0
        ? { workerRestart: summarize(workerRestart) }
        : {}),
    })
  );
});
