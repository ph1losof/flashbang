const QUERY_TYPES = [
  { label: "Prefix bang", example: "!g kittens", query: "!g kittens" },
  { label: "Suffix bang", example: "kittens g!", query: "kittens g!" },
  { label: "Prefix, query first", example: "kittens !g", query: "kittens !g" },
  { label: "Suffix, bang first", example: "g! kittens", query: "g! kittens" },
  { label: "No bang (default)", example: "kittens", query: "kittens" },
  { label: "Feeling Lucky", example: "\\kittens", query: "\\kittens" },
  { label: "Bang only", example: "!g", query: "!g" },
];

async function ensureSW(): Promise<void> {
  if (navigator.serviceWorker.controller) return;

  const reg = await navigator.serviceWorker.register("/sw.js");

  if (reg.active) {
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((r) => {
        navigator.serviceWorker.addEventListener("controllerchange", () => r(), { once: true });
      });
    }
    return;
  }

  const status = document.getElementById("sw-status")!;
  status.textContent = "Installing Service Worker…";
  status.classList.remove("hidden");

  const sw = reg.installing ?? reg.waiting;
  if (!sw) throw new Error("SW registration failed");

  await new Promise<void>((resolve) => {
    sw.addEventListener("statechange", () => {
      if (sw.state === "activated") resolve();
    });
  });
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((r) => {
      navigator.serviceWorker.addEventListener("controllerchange", () => r(), { once: true });
    });
  }

  status.textContent = "Service Worker installed.";
  setTimeout(() => status.classList.add("hidden"), 1500);
}

interface Stats {
  median: number;
  mean: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
}

type BenchResult =
  | ({ error: false } & Stats)
  | { error: true; message: string };

function computeStats(times: number[]): Stats {
  const sorted = [...times].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    median: sorted[Math.floor(n * 0.5)],
    mean: sorted.reduce((a, b) => a + b, 0) / n,
    p95: sorted[Math.floor(n * 0.95)],
    p99: sorted[Math.min(Math.floor(n * 0.99), n - 1)],
    min: sorted[0],
    max: sorted[n - 1],
  };
}

function fmt(ms: number): string {
  if (ms < 0.1) return "<0.1ms";
  if (ms < 1) return ms.toFixed(2) + "ms";
  if (ms < 10) return ms.toFixed(1) + "ms";
  if (ms < 1000) return Math.round(ms) + "ms";
  return (ms / 1000).toFixed(2) + "s";
}

async function benchQuery(
  query: string,
  iterations: number,
  onProgress: (done: number) => void,
): Promise<BenchResult> {
  const url = "/?q=" + encodeURIComponent(query);
  const opts: RequestInit = { redirect: "manual" };

  for (let i = 0; i < 50; i++) {
    try {
      await fetch(url, opts);
    } catch {}
  }

  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    try {
      await fetch(url, opts);
    } catch (e: unknown) {
      return { error: true, message: (e as Error).message || "Request failed" };
    }
    times.push(performance.now() - t0);
    onProgress(i + 1);
  }

  return { error: false, ...computeStats(times) };
}

function renderResults(results: BenchResult[]) {
  document.getElementById("results-section")!.classList.remove("hidden");

  const validMedians = results
    .filter((r): r is { error: false } & Stats => !r.error)
    .map((r) => r.median);
  const minMedian = validMedians.length > 0 ? Math.min(...validMedians) : 0;

  const tbody = document.getElementById("stats-body")!;
  tbody.innerHTML = "";
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const qt = QUERY_TYPES[i];
    const tr = document.createElement("tr");

    if (r.error) {
      tr.innerHTML =
        `<td>${qt.label}</td>` +
        `<td colspan="6" style="color:#8888a0;font-style:italic">${r.message}</td>`;
    } else {
      const cls = r.median === minMedian ? ' class="fastest"' : "";
      tr.innerHTML =
        `<td${cls}>${qt.label}</td>` +
        `<td${cls}>${fmt(r.median)}</td>` +
        `<td${cls}>${fmt(r.mean)}</td>` +
        `<td${cls}>${fmt(r.p95)}</td>` +
        `<td${cls}>${fmt(r.p99)}</td>` +
        `<td${cls}>${fmt(r.min)}</td>` +
        `<td${cls}>${fmt(r.max)}</td>`;
    }
    tbody.appendChild(tr);
  }

  if (validMedians.length > 0) {
    const sorted = [...validMedians].sort((a, b) => a - b);
    const overallMedian = sorted[Math.floor(sorted.length * 0.5)];
    const card = document.getElementById("summary-card")!;
    card.classList.remove("hidden");
    document.getElementById("summary")!.innerHTML =
      `Overall median: <span class="summary-value">${fmt(overallMedian)}</span> across all query types`;
  }
}

const runBtn = document.getElementById("run-btn") as HTMLButtonElement;
const progressEl = document.getElementById("progress")!;
const progressFill = document.getElementById("progress-fill")!;
const progressText = document.getElementById("progress-text")!;

runBtn.addEventListener("click", async () => {
  const iterations = Math.max(
    100,
    Math.min(
      5000,
      +(document.getElementById("iterations") as HTMLInputElement).value || 500,
    ),
  );

  runBtn.disabled = true;

  try {
    await ensureSW();
  } catch {
    const status = document.getElementById("sw-status")!;
    status.textContent =
      "Could not install Service Worker. Results will measure server response.";
    status.classList.remove("hidden");
  }

  progressEl.classList.remove("hidden");

  const results: BenchResult[] = [];
  const total = QUERY_TYPES.length;

  for (let qi = 0; qi < total; qi++) {
    const qt = QUERY_TYPES[qi];
    progressText.textContent = `Benchmarking: ${qt.label} (${qi + 1}/${total})…`;
    progressFill.style.width = `${(qi / total) * 100}%`;

    const result = await benchQuery(qt.query, iterations, (done) => {
      progressFill.style.width = `${((qi + done / iterations) / total) * 100}%`;
      progressText.textContent = `${qt.label}… ${done}/${iterations}`;
    });

    results.push(result);
    renderResults(results);
    await new Promise((r) => setTimeout(r, 0));
  }

  progressText.textContent = "Done";
  progressFill.style.width = "100%";
  runBtn.disabled = false;
});
