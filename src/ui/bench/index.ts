import { $ } from "../dom";
import { setupVimBlurShortcut } from "../keyboard";
import { initLiquidMetal } from "../liquid-metal";
import { computeStats, type Stats } from "./stats";

setupVimBlurShortcut();
const metal = initLiquidMetal(
  $<HTMLCanvasElement>("#metal-canvas"),
  "flashbang"
);
$(".wordmark").classList.add("has-shader");

interface QueryType {
  example: string;
  label: string;
  query?: string;
  url?: string;
}

const QUERY_TYPES: readonly QueryType[] = [
  {
    label: "SW no-op baseline",
    example: "Service Worker transport only",
    url: "/__flashbang-bench-noop",
  },
  { label: "Prefix bang", example: "!g kittens", query: "!g kittens" },
  { label: "Suffix bang", example: "kittens g!", query: "kittens g!" },
  { label: "Prefix, query first", example: "kittens !g", query: "kittens !g" },
  { label: "Suffix, bang first", example: "g! kittens", query: "g! kittens" },
  { label: "No bang (default)", example: "kittens", query: "kittens" },
  { label: "Feeling Lucky", example: "\\kittens", query: "\\kittens" },
  { label: "Bang only", example: "!g", query: "!g" },
  { label: "Prefix snap", example: "@g kittens", query: "@g kittens" },
  { label: "Suffix snap", example: "kittens @g", query: "kittens @g" },
  {
    label: "Unknown bang",
    example: "!missing kittens",
    query: "!missing kittens",
  },
  {
    label: "Custom bang",
    example: "!custom kittens",
    query: "!custom kittens",
  },
  {
    label: "Path bang",
    example: "!path hello world",
    query: "!path hello world",
  },
  {
    label: "Built-in capture",
    example: "!ktr japanese example",
    query: "!ktr japanese https://example.com/article",
  },
  {
    label: "Long query",
    example: "!g plus 200 characters",
    query: `!g ${"a".repeat(200)}`,
  },
];

const WARMUP_PER_TYPE = 50;
const FETCH_OPTIONS: RequestInit = {
  cache: "no-store",
  credentials: "same-origin",
  redirect: "manual",
};

async function ensureSW(): Promise<void> {
  if (navigator.serviceWorker.controller) {
    await navigator.serviceWorker.ready;
    return;
  }
  const status = $("#sw-status");
  status.textContent = "Installing Service Worker…";
  status.classList.remove("hidden");

  await navigator.serviceWorker.register("/sw.js");
  const registration = await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        navigator.serviceWorker.removeEventListener(
          "controllerchange",
          handleControllerChange
        );
        reject(new Error("Service Worker did not take control of the page"));
      }, 10_000);
      function handleControllerChange(): void {
        window.clearTimeout(timeout);
        navigator.serviceWorker.removeEventListener(
          "controllerchange",
          handleControllerChange
        );
        resolve();
      }
      navigator.serviceWorker.addEventListener(
        "controllerchange",
        handleControllerChange,
        { once: true }
      );
      if (navigator.serviceWorker.controller) {
        handleControllerChange();
        return;
      }
      registration.active?.postMessage({ type: "claim" });
    });
  }

  status.textContent = "Service Worker installed.";
  setTimeout(() => status.classList.add("hidden"), 1500);
}

function fmt(ms: number): string {
  if (ms < 0.01) {
    return `${(ms * 1_000).toFixed(1)}µs`;
  }
  if (ms < 0.1) {
    return `${(ms * 1_000).toFixed(0)}µs`;
  }
  if (ms < 1) {
    return `${ms.toFixed(2)}ms`;
  }
  if (ms < 10) {
    return `${ms.toFixed(1)}ms`;
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtDelta(ms: number): string {
  if (Math.abs(ms) < 0.000_001) {
    return "baseline";
  }
  return `${ms > 0 ? "+" : "-"}${fmt(Math.abs(ms))}`;
}

function benchmarkUrl(item: QueryType): string {
  if (item.url) {
    return item.url;
  }
  if (item.query !== undefined) {
    return `/?q=${encodeURIComponent(item.query)}`;
  }
  throw new Error(`Benchmark target ${item.label} has no URL or query`);
}

function shuffledSchedule(repetitions: number): number[] {
  const schedule: number[] = [];
  for (let repetition = 0; repetition < repetitions; repetition++) {
    for (let index = 0; index < QUERY_TYPES.length; index++) {
      schedule.push(index);
    }
  }
  const random = new Uint32Array(1);
  for (let i = schedule.length - 1; i > 0; i--) {
    crypto.getRandomValues(random);
    const j = random[0] % (i + 1);
    [schedule[i], schedule[j]] = [schedule[j], schedule[i]];
  }
  return schedule;
}

interface BenchmarkModeState {
  bangDataReady: boolean;
  enabled: boolean;
  navigationCount: number;
  requestCount: number;
  token: string | null;
}

interface BenchmarkCounts {
  active: boolean;
  navigationCount: number;
  requestCount: number;
}

function workerRequest<T>(data: Record<string, unknown>): Promise<T> {
  const controller = navigator.serviceWorker.controller;
  if (!controller) {
    return Promise.reject(
      new Error("The benchmark page is not Service Worker controlled")
    );
  }
  return new Promise<T>((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = window.setTimeout(
      () => reject(new Error("Service Worker benchmark handshake timed out")),
      2_000
    );
    channel.port1.onmessage = (event: MessageEvent<T>) => {
      window.clearTimeout(timeout);
      resolve(event.data);
    };
    controller.postMessage(data, [channel.port2]);
  });
}

function setBenchmarkMode(
  enabled: boolean,
  token: string
): Promise<BenchmarkModeState> {
  return workerRequest({ type: "benchmark-mode", enabled, token });
}

async function benchmarkCounts(token: string): Promise<BenchmarkCounts> {
  const state = await workerRequest<BenchmarkCounts>({
    type: "benchmark-count",
    token,
  });
  if (!(state.active && state.requestCount >= 0)) {
    throw new Error("Service Worker benchmark mode is no longer active");
  }
  return state;
}

async function fetchBenchmarkTarget(index: number): Promise<number> {
  const t0 = performance.now();
  const response = await fetch(benchmarkUrl(QUERY_TYPES[index]), FETCH_OPTIONS);
  const elapsed = performance.now() - t0;
  if (index === 0 && response.status !== 204) {
    throw new Error(
      `Invalid Service Worker baseline response: ${response.status}`
    );
  }
  return elapsed;
}

async function runBenchmark(
  iterations: number,
  token: string,
  onProgress: (done: number, index: number) => void
): Promise<Stats[]> {
  const before = await benchmarkCounts(token);
  for (const index of shuffledSchedule(WARMUP_PER_TYPE)) {
    await fetchBenchmarkTarget(index);
  }

  const samples = QUERY_TYPES.map(() => [] as number[]);
  const schedule = shuffledSchedule(iterations);
  const progressInterval = Math.max(1, Math.floor(schedule.length / 100));
  for (let i = 0; i < schedule.length; i++) {
    const index = schedule[i];
    samples[index].push(await fetchBenchmarkTarget(index));
    if ((i + 1) % progressInterval === 0 || i + 1 === schedule.length) {
      onProgress(i + 1, index);
    }
  }

  const after = await benchmarkCounts(token);
  const expected = QUERY_TYPES.length * (WARMUP_PER_TYPE + iterations);
  if (after.requestCount - before.requestCount !== expected) {
    throw new Error(
      `Service Worker handled ${after.requestCount - before.requestCount}/${expected} benchmark requests`
    );
  }
  return samples.map(computeStats);
}

function navigateBenchmarkWindow(
  target: Window,
  url: string,
  token: string,
  sequence: number
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", handleMessage);
      reject(new Error("Top-level benchmark navigation timed out"));
    }, 5_000);
    function handleMessage(event: MessageEvent): void {
      if (
        event.origin !== location.origin ||
        event.data?.type !== "flashbang-benchmark-navigation" ||
        event.data.token !== token ||
        event.data.sequence !== sequence
      ) {
        return;
      }
      window.clearTimeout(timeout);
      window.removeEventListener("message", handleMessage);
      resolve(performance.now() - startedAt);
    }
    window.addEventListener("message", handleMessage);
    const startedAt = performance.now();
    target.location.href = url;
  });
}

async function runNavigationBenchmark(
  iterations: number,
  token: string,
  target: Window,
  onProgress: (done: number, total: number) => void
): Promise<
  readonly [direct: Stats, redirected: Stats, delta: Stats, rounds: number]
> {
  const warmupRounds = 5;
  const measuredRounds = Math.min(iterations, 100);
  const totalRounds = warmupRounds + measuredRounds;
  const direct: number[] = [];
  const redirected: number[] = [];
  const deltas: number[] = [];
  const before = await benchmarkCounts(token);
  const random = new Uint32Array(1);

  for (let round = 0; round < totalRounds; round++) {
    const query = QUERY_TYPES[1 + (round % (QUERY_TYPES.length - 1))].query!;
    crypto.getRandomValues(random);
    const redirectFirst = (random[0] & 1) === 1;
    const kinds = redirectFirst
      ? (["redirect", "direct"] as const)
      : (["direct", "redirect"] as const);
    let directElapsed = 0;
    let redirectedElapsed = 0;
    for (let order = 0; order < kinds.length; order++) {
      const sequence = round * 2 + order;
      const directUrl = `/__flashbang-bench-target?fb-bench=${encodeURIComponent(token)}&fb-seq=${sequence}`;
      const redirectUrl = `/?q=${encodeURIComponent(query)}&fb-bench=${encodeURIComponent(token)}&fb-seq=${sequence}`;
      const kind = kinds[order];
      const elapsed = await navigateBenchmarkWindow(
        target,
        kind === "direct" ? directUrl : redirectUrl,
        token,
        sequence
      );
      if (round >= warmupRounds) {
        if (kind === "direct") {
          directElapsed = elapsed;
          direct.push(elapsed);
        } else {
          redirectedElapsed = elapsed;
          redirected.push(elapsed);
        }
      }
    }
    if (round >= warmupRounds) {
      deltas.push(redirectedElapsed - directElapsed);
      onProgress(round - warmupRounds + 1, measuredRounds);
    }
  }

  const after = await benchmarkCounts(token);
  if (after.navigationCount - before.navigationCount !== totalRounds) {
    throw new Error(
      `Service Worker handled ${after.navigationCount - before.navigationCount}/${totalRounds} top-level redirect navigations`
    );
  }
  return [
    computeStats(direct),
    computeStats(redirected),
    computeStats(deltas),
    measuredRounds,
  ];
}

function renderResults(results: Stats[]) {
  $("#results-section").classList.remove("hidden");

  const baseline = results[0];
  const queryMedians = results.slice(1).map((result) => result.median);
  const minMedian = Math.min(...queryMedians);

  const tbody = $("#stats-body");
  tbody.replaceChildren();
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const qt = QUERY_TYPES[i];
    const tr = document.createElement("tr");
    const cls = i > 0 && r.median === minMedian ? "fastest" : "";
    for (const text of [
      qt.label,
      fmt(r.median),
      fmtDelta(r.median - baseline.median),
      fmt(r.mean),
      fmt(r.p95),
      fmt(r.mad),
      `${fmt(r.medianCiLow)}–${fmt(r.medianCiHigh)}`,
      fmt(r.min),
      fmt(r.max),
    ]) {
      const td = document.createElement("td");
      if (cls) {
        td.className = cls;
      }
      td.textContent = text;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  const sorted = [...queryMedians].sort((a, b) => a - b);
  const overallMedian = computeStats(sorted).median;
  const card = $("#summary-card");
  card.classList.remove("hidden");
  const summary = $("#summary");
  summary.textContent = "";
  summary.append(
    "Median redirect fetch RTT: ",
    Object.assign(document.createElement("span"), {
      className: "summary-value",
      textContent: fmt(overallMedian),
    }),
    `; Service Worker transport baseline: ${fmt(baseline.median)}; median processing delta: ${fmtDelta(overallMedian - baseline.median)}`
  );
}

function renderNavigationResults(
  direct: Stats,
  redirected: Stats,
  delta: Stats,
  rounds: number
): void {
  const card = $("#navigation-summary-card");
  card.classList.remove("hidden");
  const summary = $("#navigation-summary");
  summary.textContent = `Paired top-level navigation (${rounds} rounds): direct target ${fmt(direct.median)} median; parsed 302 path ${fmt(redirected.median)} median; paired redirect overhead ${fmtDelta(delta.median)} (95% median CI ${fmtDelta(delta.medianCiLow)} to ${fmtDelta(delta.medianCiHigh)}); redirected p95 ${fmt(redirected.p95)}.`;
}

const runBtn = $<HTMLButtonElement>("#run-btn");
const progressEl = $("#progress");
const progressFill = $("#progress-fill");
const progressText = $("#progress-text");

async function prepareBenchmarkPage(): Promise<void> {
  runBtn.disabled = true;
  try {
    await ensureSW();
    if (!crossOriginIsolated) {
      location.reload();
      return;
    }
    runBtn.disabled = false;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Service Worker setup failed";
    const status = $("#sw-status");
    status.textContent = `Benchmark unavailable: ${message}`;
    status.classList.remove("hidden");
  }
}

void prepareBenchmarkPage();

runBtn.addEventListener("click", async () => {
  const iterations = Math.max(
    100,
    Math.min(5000, +$<HTMLInputElement>("#iterations").value || 500)
  );

  runBtn.disabled = true;
  metal.pause();
  let benchmarkModeEnabled = false;
  const token = crypto.randomUUID();
  const navigationWindow = window.open(
    "about:blank",
    "flashbang-benchmark-navigation",
    "popup,width=360,height=180"
  );

  try {
    if (!navigationWindow) {
      throw new Error("Allow the benchmark navigation popup and try again");
    }
    if (document.visibilityState !== "visible") {
      throw new Error("Keep the benchmark tab visible while measuring");
    }
    if (!crossOriginIsolated) {
      throw new Error(
        "High-resolution timing is unavailable. Reload /bench after the latest deployment."
      );
    }
    await ensureSW();
    const mode = await setBenchmarkMode(true, token);
    if (!(mode.enabled && mode.bangDataReady && mode.token === token)) {
      throw new Error("Service Worker rejected validated benchmark mode");
    }
    benchmarkModeEnabled = true;

    progressEl.classList.remove("hidden");
    $("#results-section").classList.add("hidden");
    $("#summary-card").classList.add("hidden");
    $("#navigation-summary-card").classList.add("hidden");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const measuredTotal = QUERY_TYPES.length * iterations;
    const results = await runBenchmark(iterations, token, (done, index) => {
      progressFill.style.width = `${(done / measuredTotal) * 100}%`;
      progressText.textContent = `${QUERY_TYPES[index].label} · ${done.toLocaleString()}/${measuredTotal.toLocaleString()}`;
    });
    renderResults(results);

    progressText.textContent = "Benchmarking paired top-level navigation…";
    const [
      directNavigation,
      redirectedNavigation,
      navigationDelta,
      navigationRounds,
    ] = await runNavigationBenchmark(
      iterations,
      token,
      navigationWindow,
      (done, total) => {
        progressText.textContent = `Top-level navigation · ${done}/${total}`;
      }
    );
    renderNavigationResults(
      directNavigation,
      redirectedNavigation,
      navigationDelta,
      navigationRounds
    );

    progressText.textContent = "Done";
    progressFill.style.width = "100%";
    const status = $("#sw-status");
    status.classList.add("hidden");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Benchmark failed";
    const status = $("#sw-status");
    status.textContent = `Benchmark aborted: ${message}`;
    status.classList.remove("hidden");
    progressEl.classList.remove("hidden");
    progressText.textContent = "Benchmark aborted";
  } finally {
    navigationWindow?.close();
    if (benchmarkModeEnabled) {
      await setBenchmarkMode(false, token).catch(() => {
        /* The client-scoped mode cannot affect other tabs. */
      });
    }
    metal.resume();
    runBtn.disabled = false;
  }
});
