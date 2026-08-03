import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  canvasContextFactory,
  type DomHandle,
  type FakeChildWindow,
  fire,
  installDom,
  readBenchHtml,
} from "./helpers/dom";

/**
 * `src/ui/bench/index.ts` wires the whole benchmark page from its top level, so
 * it is imported once against a Service Worker controlled, cross-origin isolated
 * page — the only state in which the run button becomes usable. Everything after
 * that is driven through the button, with the worker and network stubs below
 * swapped per test.
 */

let handle: DomHandle;
let bench: unknown;

/** Mutable stubs the module reads on every call. */
interface WorkerBehaviour {
  benchmarkMode: (data: Record<string, unknown>) => unknown;
  counts: () => {
    active: boolean;
    navigationCount: number;
    requestCount: number;
  };
  silent: boolean;
}

let requestCount = 0;
let navigationCount = 0;
let worker: WorkerBehaviour;
let fetchStatus: number;
let navigateHandler: ((url: string, child: FakeChildWindow) => void) | null;
let openResult: "window" | "blocked";

function currentCounts(): {
  active: boolean;
  navigationCount: number;
  requestCount: number;
} {
  return { active: true, navigationCount, requestCount };
}

function resetBehaviour(): void {
  requestCount = 0;
  navigationCount = 0;
  fetchStatus = 204;
  openResult = "window";
  worker = {
    benchmarkMode: (data) => ({
      bangDataReady: true,
      enabled: data.enabled,
      navigationCount,
      requestCount,
      token: data.token,
    }),
    counts: currentCounts,
    silent: false,
  };
  // Each top-level navigation answers with the postMessage the page waits for.
  navigateHandler = (url, child) => {
    const params = new URL(url, "https://flashbang.test").searchParams;
    const token = params.get("fb-bench");
    const sequence = Number(params.get("fb-seq"));
    if (url.includes("?q=")) {
      navigationCount++;
    }
    handle.fireWindow("message", {
      origin: "https://flashbang.test",
      data: {
        type: "flashbang-benchmark-navigation",
        token,
        sequence,
      },
    });
    void child;
  };
}

beforeAll(async () => {
  resetBehaviour();

  const controller = {
    postMessage(data: Record<string, unknown>, ports: MessagePort[] = []) {
      if (worker.silent) {
        return;
      }
      const reply =
        data.type === "benchmark-mode"
          ? worker.benchmarkMode(data)
          : worker.counts();
      ports[0]?.postMessage(reply);
    },
  };
  const serviceWorker = {
    controller,
    ready: Promise.resolve({ active: controller }),
    register: () => Promise.resolve({ active: controller }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    getRegistration: () => Promise.resolve({ active: controller }),
  };

  handle = installDom({
    html: await readBenchHtml(),
    serviceWorker,
    url: "https://flashbang.test/bench",
    canvasContext: canvasContextFactory(null),
  });

  // Count every benchmark request the way the worker would.
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.fetch = (input: unknown) => {
    requestCount++;
    const url = String(input);
    return Promise.resolve(
      new Response(null, {
        status: url.includes("bench-noop") ? fetchStatus : 302,
      })
    );
  };

  const windowTarget = handle.window as unknown as {
    open: (url?: string) => FakeChildWindow | null;
  };
  const realOpen = windowTarget.open;
  windowTarget.open = (url?: string) => {
    if (openResult === "blocked") {
      return null;
    }
    const child = realOpen.call(handle.window, url);
    if (child) {
      child.onNavigate = (href, target) => navigateHandler?.(href, target);
    }
    return child;
  };

  bench = await import("../src/ui/bench/index");
  await handle.settle();
});

afterAll(() => {
  handle.restore();
});

beforeEach(() => {
  resetBehaviour();
});

function query<T extends HTMLElement>(selector: string): T {
  const found = handle.document.querySelector(selector);
  if (!found) {
    throw new Error(`Missing element: ${selector}`);
  }
  return found as unknown as T;
}

/** Clicks Run and drives the clock until the page stops working. */
async function runBenchmark(iterations = 100): Promise<void> {
  query<HTMLInputElement>("#iterations").value = String(iterations);
  const runButton = query<HTMLButtonElement>("#run-btn");
  fire(runButton, "click");
  // Generous budget: the page's own guards run on 2s and 5s timeouts.
  for (let pass = 0; pass < 150 && runButton.disabled; pass++) {
    await handle.advance(200);
  }
}

describe("benchmark page setup", () => {
  test("loads and enables the run button", () => {
    expect(bench).toBeDefined();
    expect(query<HTMLButtonElement>("#run-btn").disabled).toBe(false);
    expect(query(".wordmark").classList.contains("has-shader")).toBe(true);
  });
});

describe("a successful benchmark run", () => {
  test("reports per-query statistics and both summaries", async () => {
    await runBenchmark();

    expect(query("#sw-status").classList.contains("hidden")).toBe(true);
    expect(query("#results-section").classList.contains("hidden")).toBe(false);
    expect(query("#summary-card").classList.contains("hidden")).toBe(false);
    expect(query("#navigation-summary-card").classList.contains("hidden")).toBe(
      false
    );
    expect(query("#progress-text").textContent).toBe("Done");
    expect(query("#progress-fill").style.width).toBe("100%");
  });

  test("renders one row per query type with a baseline delta", async () => {
    await runBenchmark();

    const rows = query("#stats-body").querySelectorAll("tr");
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0].textContent).toContain("SW no-op baseline");
    expect(rows[0].textContent).toContain("baseline");
    expect(query("#summary").textContent).toContain(
      "Median redirect fetch RTT:"
    );
    expect(query("#navigation-summary").textContent).toContain(
      "Paired top-level navigation"
    );
  });

  test("marks exactly one query row as fastest", async () => {
    await runBenchmark();

    const fastest = query("#stats-body").querySelectorAll(".fastest");
    expect(fastest.length).toBeGreaterThan(0);
  });

  test("closes the navigation popup and re-enables the button", async () => {
    await runBenchmark();

    expect(handle.openedWindows.at(-1)?.closed).toBe(true);
    expect(query<HTMLButtonElement>("#run-btn").disabled).toBe(false);
  });

  test("clamps a tiny iteration count up to the minimum", async () => {
    await runBenchmark(1);

    // 15 query types x (50 warmup + 100 clamped iterations).
    expect(requestCount).toBe(15 * 150);
  });

  test("clamps a huge iteration count down to the maximum", async () => {
    query<HTMLInputElement>("#iterations").value = "999999";
    const runButton = query<HTMLButtonElement>("#run-btn");

    fire(runButton, "click");
    // Only the request budget matters here, so stop as soon as it is visible.
    for (let pass = 0; pass < 10 && requestCount < 15 * 5050; pass++) {
      await handle.advance(60);
    }

    expect(requestCount).toBeLessThanOrEqual(15 * 5050);
    for (let pass = 0; pass < 200 && runButton.disabled; pass++) {
      await handle.advance(60);
    }
  });
});

describe("benchmark run failures", () => {
  test("aborts when the navigation popup is blocked", async () => {
    openResult = "blocked";

    await runBenchmark();

    expect(query("#sw-status").textContent).toBe(
      "Benchmark aborted: Allow the benchmark navigation popup and try again"
    );
    expect(query("#progress-text").textContent).toBe("Benchmark aborted");
    expect(query<HTMLButtonElement>("#run-btn").disabled).toBe(false);
  });

  test("aborts when the tab is not visible", async () => {
    handle.document.visibilityState = "hidden";

    await runBenchmark();

    expect(query("#sw-status").textContent).toBe(
      "Benchmark aborted: Keep the benchmark tab visible while measuring"
    );
    handle.document.visibilityState = "visible";
  });

  test("aborts when the worker rejects benchmark mode", async () => {
    worker.benchmarkMode = () => ({
      bangDataReady: false,
      enabled: false,
      token: null,
    });

    await runBenchmark();

    expect(query("#sw-status").textContent).toBe(
      "Benchmark aborted: Service Worker rejected validated benchmark mode"
    );
  });

  test("aborts when benchmark mode is no longer active", async () => {
    worker.counts = () => ({
      active: false,
      navigationCount,
      requestCount,
    });

    await runBenchmark();

    expect(query("#sw-status").textContent).toBe(
      "Benchmark aborted: Service Worker benchmark mode is no longer active"
    );
  });

  test("aborts when the worker misses some benchmark requests", async () => {
    // Under-report so the request reconciliation fails.
    worker.counts = () => ({
      active: true,
      navigationCount,
      requestCount: Math.floor(requestCount / 2),
    });

    await runBenchmark();

    expect(query("#sw-status").textContent).toContain("benchmark requests");
  });

  test("aborts when the baseline response is not a 204", async () => {
    fetchStatus = 500;

    await runBenchmark();

    expect(query("#sw-status").textContent).toContain(
      "Invalid Service Worker baseline response: 500"
    );
  });

  test("aborts when a top-level navigation never reports back", async () => {
    navigateHandler = null;

    await runBenchmark();

    expect(query("#sw-status").textContent).toContain(
      "Top-level benchmark navigation timed out"
    );
  });

  test("aborts when the worker handshake times out", async () => {
    worker.silent = true;

    await runBenchmark();

    expect(query("#sw-status").textContent).toContain(
      "Service Worker benchmark handshake timed out"
    );
  });

  test("aborts when the worker misses top-level navigations", async () => {
    const counts = () => ({
      active: true,
      // Freeze the navigation tally so reconciliation fails.
      navigationCount: 0,
      requestCount,
    });
    worker.counts = counts;

    await runBenchmark();

    expect(query("#sw-status").textContent).toContain(
      "top-level redirect navigations"
    );
  });
});
