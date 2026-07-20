export interface Stats {
  mad: number;
  max: number;
  mean: number;
  median: number;
  medianCiHigh: number;
  medianCiLow: number;
  min: number;
  p95: number;
}

function medianSorted(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function computeStats(times: readonly number[]): Stats {
  if (times.length === 0) {
    throw new Error("Cannot summarize an empty benchmark sample");
  }
  const sorted = [...times].sort((a, b) => a - b);
  const median = medianSorted(sorted);
  const deviations = sorted
    .map((value) => Math.abs(value - median))
    .sort((a, b) => a - b);
  const ciOffset = Math.max(
    0,
    Math.floor((sorted.length - 1.96 * Math.sqrt(sorted.length)) / 2)
  );
  return {
    median,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)],
    mad: medianSorted(deviations),
    medianCiLow: sorted[ciOffset],
    medianCiHigh: sorted[sorted.length - ciOffset - 1],
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}
