// M7 fixed performance gate: pure helpers for measuring pinned-corpus
// analysis runs and comparing them against docs/performance-baseline.v1.json
// thresholds. The gate script (scripts/performance-gate.ts) does the I/O.

export interface PerformanceGateRun {
  status: string;
  elapsedMs: number;
  peakRssBytes?: number;
  jsonBytes: number;
  evidenceBytes: number;
}

export interface PerformanceGateThresholds {
  medianElapsedMs: number;
  worstElapsedMs: number;
  maxPeakRssBytes: number;
  maxJsonBytes: number;
  maxEvidenceBytes: number;
  maximumUnreviewedRegressionFraction: number;
}

export interface PerformanceGateResult {
  passed: boolean;
  summary: {
    runs: number;
    medianElapsedMs: number;
    worstElapsedMs: number;
    maxPeakRssBytes?: number;
    maxJsonBytes: number;
    maxEvidenceBytes: number;
  };
  checks: Array<{ name: string; passed: boolean; actual: number | string; threshold: number | string }>;
}

export function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function parsePeakRssBytes(timeStderr: string, platform: "darwin" | "linux"): number | undefined {
  if (platform === "darwin") {
    // /usr/bin/time -l on darwin already reports bytes.
    const match = timeStderr.match(/(\d+)\s+maximum resident set size/);
    return match ? Number(match[1]) : undefined;
  }
  const match = timeStderr.match(/Maximum resident set size \(kbytes\):\s*(\d+)/);
  return match ? Number(match[1]) * 1024 : undefined;
}

export function evaluatePerformanceGate(input: { runs: PerformanceGateRun[]; thresholds: PerformanceGateThresholds }): PerformanceGateResult {
  const { runs, thresholds } = input;
  const elapsed = runs.map((run) => run.elapsedMs);
  const medianElapsed = medianOf(elapsed);
  const worstElapsed = Math.max(...elapsed);
  const peakRss = runs.map((run) => run.peakRssBytes).filter((value): value is number => value !== undefined);
  const maxPeakRss = peakRss.length > 0 ? Math.max(...peakRss) : undefined;
  const maxJson = Math.max(...runs.map((run) => run.jsonBytes));
  const maxEvidence = Math.max(...runs.map((run) => run.evidenceBytes));
  const allFactsReady = runs.every((run) => run.status === "facts-ready");

  const checks: PerformanceGateResult["checks"] = [
    { name: "semanticStatus", passed: allFactsReady, actual: allFactsReady ? "facts-ready" : "non-facts-ready run", threshold: "facts-ready in all runs" },
    { name: "medianElapsed", passed: medianElapsed <= thresholds.medianElapsedMs, actual: medianElapsed, threshold: thresholds.medianElapsedMs },
    { name: "worstElapsed", passed: worstElapsed <= thresholds.worstElapsedMs, actual: worstElapsed, threshold: thresholds.worstElapsedMs },
    ...(maxPeakRss !== undefined ? [{ name: "peakRss", passed: maxPeakRss <= thresholds.maxPeakRssBytes, actual: maxPeakRss, threshold: thresholds.maxPeakRssBytes }] : []),
    { name: "jsonSize", passed: maxJson <= thresholds.maxJsonBytes, actual: maxJson, threshold: thresholds.maxJsonBytes },
    { name: "evidenceSize", passed: maxEvidence <= thresholds.maxEvidenceBytes, actual: maxEvidence, threshold: thresholds.maxEvidenceBytes },
  ];

  return {
    passed: checks.every((check) => check.passed),
    summary: {
      runs: runs.length,
      medianElapsedMs: medianElapsed,
      worstElapsedMs: worstElapsed,
      maxPeakRssBytes: maxPeakRss,
      maxJsonBytes: maxJson,
      maxEvidenceBytes: maxEvidence,
    },
    checks,
  };
}
