import { readdirSync } from "node:fs";
import { type Browser, chromium } from "@playwright/test";
import { bangShardIndex } from "../src/shared/bang-shards";
import { hashFNV1a } from "../src/shared/hash";

const samples = Number(process.env.AB_SAMPLES ?? 30);
const warmups = Number(process.env.AB_WARMUPS ?? 5);
const trigger = process.env.AB_TRIGGER ?? "mdn";
const coldNetwork = process.env.AB_COLD_NETWORK === "true";

interface Distribution {
  mean: number;
  median: number;
  p95: number;
  samples: number;
}

function distribution(values: readonly number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (value: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))];
  return {
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    median: percentile(0.5),
    p95: percentile(0.95),
    samples: values.length,
  };
}

function catalogAssets(distDir: string): {
  full: string;
  shard: string;
} {
  const files = readdirSync(distDir);
  const full = files.find((name) => /^bangs-[a-f0-9]{12}\.bin$/.test(name));
  const shardId = bangShardIndex(hashFNV1a(trigger));
  const shardPrefix = `bangs-s${shardId.toString(16)}-`;
  const shard = files.find(
    (name) => name.startsWith(shardPrefix) && name.endsWith(".bin")
  );
  if (!(full && shard)) {
    throw new Error(`Missing benchmark catalog assets in ${distDir}`);
  }
  return { full: `/${full}`, shard: `/${shard}` };
}

async function waitForServer(url: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`${url}/health`)).ok) {
        return;
      }
    } catch {
      // Server is still starting.
    }
    await Bun.sleep(25);
  }
  throw new Error(`Server did not start: ${url}`);
}

async function closeWorker(browser: Browser, baseUrl: string): Promise<void> {
  const cdp = await browser.newBrowserCDPSession();
  try {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const worker = targetInfos.find(
      (target) =>
        target.type === "service_worker" && target.url === `${baseUrl}/sw.js`
    );
    if (!worker) {
      throw new Error(`Service Worker target not found for ${baseUrl}`);
    }
    await cdp.send("Target.closeTarget", { targetId: worker.targetId });
  } finally {
    await cdp.detach();
  }
}

async function runVariant(
  name: string,
  distDir: string,
  port: number,
  sampleCount: number
): Promise<{ durations: number[]; name: string }> {
  const baseUrl = `http://127.0.0.1:${port}`;
  const assets = catalogAssets(distDir);
  const server = Bun.spawn(["bun", "scripts/start.ts"], {
    env: { ...process.env, DIST_DIR: distDir, PORT: String(port) },
    stderr: "inherit",
    stdout: "ignore",
  });
  await waitForServer(baseUrl);
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await context.route("https://developer.mozilla.org/**", (route) =>
      route.fulfill({ body: "mdn", contentType: "text/plain", status: 200 })
    );
    const page = await context.newPage();
    await page.goto(`${baseUrl}/`);
    await page.waitForFunction(
      () =>
        "serviceWorker" in navigator &&
        navigator.serviceWorker.controller !== null
    );
    await page.waitForFunction(async (fullAsset) => {
      for (const cacheName of await caches.keys()) {
        if (await (await caches.open(cacheName)).match(fullAsset)) {
          return true;
        }
      }
      return false;
    }, assets.full);
    await page.evaluate(async (shardAsset) => {
      const response = await fetch(shardAsset);
      for (const cacheName of await caches.keys()) {
        const cache = await caches.open(cacheName);
        const requests = await cache.keys();
        if (
          requests.some(({ url }) =>
            /^\/bangs-[a-f0-9]{12}\.bin$/.test(new URL(url).pathname)
          )
        ) {
          await cache.put(shardAsset, response);
          return;
        }
      }
      throw new Error("Current Flashbang cache not found");
    }, assets.shard);

    const durations: number[] = [];
    for (let sample = -warmups; sample < sampleCount; sample++) {
      await page.goto(`${baseUrl}/health`);
      await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;
        await registration.navigationPreload.setHeaderValue("invalid");
        await registration.navigationPreload.disable();
      });
      if (coldNetwork) {
        await page.evaluate(async () => {
          for (const cacheName of await caches.keys()) {
            const cache = await caches.open(cacheName);
            for (const request of await cache.keys()) {
              const pathname = new URL(request.url).pathname;
              if (
                pathname.startsWith("/bangs-") &&
                !pathname.startsWith("/bangs-meta-")
              ) {
                await cache.delete(request);
              }
            }
          }
        });
        const pageCdp = await context.newCDPSession(page);
        try {
          await pageCdp.send("Network.clearBrowserCache");
        } finally {
          await pageCdp.detach();
        }
      }
      await closeWorker(browser, baseUrl);
      const start = performance.now();
      await page.goto(`${baseUrl}/?q=%21${trigger}%20array`, {
        waitUntil: "commit",
      });
      const elapsed = performance.now() - start;
      if (!page.url().startsWith("https://developer.mozilla.org/")) {
        throw new Error(`Unexpected redirect target: ${page.url()}`);
      }
      if (sample >= 0) {
        durations.push(elapsed);
      }
    }
    await context.close();
    return { durations, name };
  } finally {
    await browser.close();
    server.kill();
    await server.exited;
  }
}

const baselineDir = process.env.AB_BASELINE_DIR ?? "dist-a";
const variantDir = process.env.AB_VARIANT_DIR ?? "dist-b";
const blockSamples = Math.ceil(samples / 2);
const blocks = [
  await runVariant("baseline", baselineDir, 43_871, blockSamples),
  await runVariant("on-demand-shards", variantDir, 43_872, blockSamples),
  await runVariant("on-demand-shards", variantDir, 43_872, blockSamples),
  await runVariant("baseline", baselineDir, 43_871, blockSamples),
];
const baselineValues = blocks
  .filter(({ name }) => name === "baseline")
  .flatMap(({ durations }) => durations);
const variantValues = blocks
  .filter(({ name }) => name === "on-demand-shards")
  .flatMap(({ durations }) => durations);
const baseline = distribution(baselineValues);
const variant = distribution(variantValues);
const medianDelta =
  ((variant.median - baseline.median) / baseline.median) * 100;

console.log(
  JSON.stringify(
    {
      baseline: { distribution: baseline, name: "baseline" },
      blocks: blocks.map(({ durations, name }) => ({
        distribution: distribution(durations),
        name,
      })),
      medianDeltaPercent: medianDelta,
      coldNetwork,
      trigger,
      variant: { distribution: variant, name: "on-demand-shards" },
      warmups,
    },
    null,
    2
  )
);
