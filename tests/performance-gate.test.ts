import { describe, expect, it } from "vitest";
import { medianOf, parsePeakRssBytes, evaluatePerformanceGate } from "../src/core/performance-gate.js";

describe("performance gate measurement helpers", () => {
  it("computes the median of three runs", () => {
    expect(medianOf([7981, 7620, 8156])).toBe(7981);
    expect(medianOf([100])).toBe(100);
    expect(medianOf([10, 20])).toBe(15);
  });

  it("parses darwin /usr/bin/time -l peak RSS in bytes", () => {
    const stderr = [
      "        0.02 real         0.01 user         0.00 sys",
      "  565329920  maximum resident set size",
      "         0 page reclaims",
    ].join("\n");
    expect(parsePeakRssBytes(stderr, "darwin")).toBe(565329920);
  });

  it("parses linux /usr/bin/time -v peak RSS from kbytes", () => {
    const stderr = "\tMaximum resident set size (kbytes): 535488\n";
    expect(parsePeakRssBytes(stderr, "linux")).toBe(535488 * 1024);
  });

  it("returns undefined when no RSS line is present", () => {
    expect(parsePeakRssBytes("nothing useful", "darwin")).toBeUndefined();
  });
});

describe("performance gate evaluation", () => {
  const thresholds = {
    medianElapsedMs: 60000,
    worstElapsedMs: 90000,
    maxPeakRssBytes: 1073741824,
    maxJsonBytes: 262144000,
    maxEvidenceBytes: 104857600,
    maximumUnreviewedRegressionFraction: 0.2,
  };

  it("passes when all measurements are within thresholds", () => {
    const result = evaluatePerformanceGate({
      runs: [
        { status: "facts-ready", elapsedMs: 8000, peakRssBytes: 565329920, jsonBytes: 23732161, evidenceBytes: 5996226 },
        { status: "facts-ready", elapsedMs: 7620, peakRssBytes: 550000000, jsonBytes: 23732161, evidenceBytes: 5996226 },
        { status: "facts-ready", elapsedMs: 8156, peakRssBytes: 565000000, jsonBytes: 23732161, evidenceBytes: 5996226 },
      ],
      thresholds,
    });
    expect(result.passed).toBe(true);
    expect(result.summary.medianElapsedMs).toBe(8000);
    expect(result.summary.worstElapsedMs).toBe(8156);
    expect(result.summary.maxPeakRssBytes).toBe(565329920);
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it("fails when the median elapsed exceeds the threshold", () => {
    const result = evaluatePerformanceGate({
      runs: [
        { status: "facts-ready", elapsedMs: 70000, peakRssBytes: 100, jsonBytes: 1, evidenceBytes: 1 },
        { status: "facts-ready", elapsedMs: 70000, peakRssBytes: 100, jsonBytes: 1, evidenceBytes: 1 },
        { status: "facts-ready", elapsedMs: 70000, peakRssBytes: 100, jsonBytes: 1, evidenceBytes: 1 },
      ],
      thresholds,
    });
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.name === "medianElapsed")?.passed).toBe(false);
  });

  it("fails when a run is not facts-ready", () => {
    const result = evaluatePerformanceGate({
      runs: [
        { status: "facts-ready", elapsedMs: 8000, peakRssBytes: 100, jsonBytes: 1, evidenceBytes: 1 },
        { status: "error", elapsedMs: 8000, peakRssBytes: 100, jsonBytes: 1, evidenceBytes: 1 },
        { status: "facts-ready", elapsedMs: 8000, peakRssBytes: 100, jsonBytes: 1, evidenceBytes: 1 },
      ],
      thresholds,
    });
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.name === "semanticStatus")?.passed).toBe(false);
  });

  it("fails when output bytes exceed the thresholds", () => {
    const result = evaluatePerformanceGate({
      runs: [
        { status: "facts-ready", elapsedMs: 100, peakRssBytes: 100, jsonBytes: 300000000, evidenceBytes: 200000000 },
      ],
      thresholds,
    });
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.name === "jsonSize")?.passed).toBe(false);
    expect(result.checks.find((c) => c.name === "evidenceSize")?.passed).toBe(false);
  });
});
