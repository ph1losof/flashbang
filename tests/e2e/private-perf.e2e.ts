import { type Page, test } from "@playwright/test";

const GOOGLE = "https://www.google.com";
const COLD_RUNS = Number(process.env.PROFILE_COLD_RUNS ?? 12);
const WARM_RUNS = Number(process.env.PROFILE_WARM_RUNS ?? 30);
const NETWORK_DELAY_MS = Math.max(
  0,
  Number(process.env.PROFILE_NETWORK_DELAY_MS) || 0
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
  if (NETWORK_DELAY_MS === 0) {
    return;
  }
  const origin = new URL(baseURL).origin;
  await page.context().route(`${origin}/**`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, NETWORK_DELAY_MS));
    await route.continue();
  });
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
    await page.addInitScript(() => {
      Reflect.deleteProperty(Navigator.prototype, "serviceWorker");
    });
    await conditionColdNetwork(page, baseURL);
    await mockGoogle(page);
    cold.push(await measure(page));
    await context.close();
  }

  const firstInstall: Timing[] = [];
  const postInstall: Timing[] = [];
  for (let i = 0; i < COLD_RUNS; i++) {
    const context = await browser.newContext();
    const page = await context.newPage();
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
      cold: summarize(cold),
      controlledWarm: summarize(warm),
      documentFloor: summarize(documentFloor),
      firstInstall: summarize(firstInstall),
      networkDelayMs: NETWORK_DELAY_MS,
      postInstall: summarize(postInstall),
      publicWarm: summarize(publicWarm),
    })
  );
});
