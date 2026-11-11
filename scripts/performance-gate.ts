#!/usr/bin/env node
// M7 fixed performance gate (plan: docs/performance-baseline.v1.json).
// Runs the built CLI against the pinned Authelia corpus --no-render three
// times, measures elapsed (receipt), peak RSS (/usr/bin/time), and output
// sizes, then compares against the thresholds recorded in the baseline doc.
// Read-only wrt the repo; writes scratch outputs under .repomap/.
// Expects `npm run build` to have produced dist/cli.js.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluatePerformanceGate, parsePeakRssBytes, type PerformanceGateRun } from "../src/core/performance-gate.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const baselinePath = resolve(root, "docs/performance-baseline.v1.json");
const cliPath = join(root, "dist/cli.js");

const runsArgIndex = process.argv.indexOf("--runs");
const runCount = runsArgIndex >= 0 ? Number(process.argv[runsArgIndex + 1]) : 3;
if (!Number.isInteger(runCount) || runCount < 1) {
  console.error("usage: tsx scripts/performance-gate.ts [--runs 3]");
  process.exit(2);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const { repository, revision } = baseline.source;
const thresholds = baseline.thresholds;

if (!existsSync(cliPath)) {
  console.error("dist/cli.js is missing; run npm run build first");
  process.exit(2);
}

const work = await mkdtemp(join(tmpdir(), "repomap-perf-"));
const runs: PerformanceGateRun[] = [];

function runAnalysis(outDir: string): { stderr: string; receiptPath: string } {
  const timePath = "/usr/bin/time";
  const timeFlag = process.platform === "darwin" ? "-l" : "-v";
  const result = spawnSync(timePath, [timeFlag, "node", cliPath, "analyze", `${repository}@${revision}`, "--no-render", "--out", outDir], {
    cwd: root,
    encoding: "utf8",
    timeout: 600000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, REPOMAP_CACHE_DIR: join(root, ".repomap/cache") },
  });
  const receiptPath = join(outDir, "repomap.receipt.json");
  if (!existsSync(receiptPath)) {
    console.error(`no receipt; spawn error: ${result.error?.message ?? "none"}; stderr tail:\n${result.stderr?.slice(-2000)}`);
    process.exit(1);
  }
  return { stderr: result.stderr ?? "", receiptPath };
}

function measure(outDir: string, stderr: string): PerformanceGateRun {
  const receipt = JSON.parse(readFileSync(join(outDir, "repomap.receipt.json"), "utf8"));
  const peakRssBytes = parsePeakRssBytes(stderr, process.platform === "darwin" ? "darwin" : "linux");
  // Semantic artifact set only; per-page view JSONs scale with page count and
  // have their own M6 delivery gates, so they are excluded here.
  const semanticArtifacts = [
    "architecture.analysis.json",
    "architecture.ir.json",
    "architecture.evidence.json",
    "architecture.route-graph.json",
    "architecture.async-graph.json",
    "architecture.declarations.json",
    "architecture.facts.json",
    "architecture.candidates.json",
    "architecture.delivery.json",
  ].filter((file) => existsSync(join(outDir, file)));
  const jsonBytes = semanticArtifacts.reduce((total, file) => total + statSync(join(outDir, file)).size, 0);
  const evidenceBytes = statSync(join(outDir, "architecture.evidence.json")).size;
  return {
    status: receipt.error ? "error" : "facts-ready",
    elapsedMs: receipt.elapsedMs,
    peakRssBytes,
    jsonBytes,
    evidenceBytes,
  };
}

try {
  // Warm-up run: populates the archive cache so counted runs measure pure
  // analysis time. Its output is discarded.
  const warmupDir = join(work, "warmup");
  runAnalysis(warmupDir);
  for (let index = 1; index <= runCount; index += 1) {
    const outDir = join(work, `run-${index}`);
    const { stderr } = runAnalysis(outDir);
    const run = measure(outDir, stderr);
    runs.push(run);
    console.error(`run ${index}: status=${run.status} elapsedMs=${run.elapsedMs} peakRssBytes=${run.peakRssBytes ?? "unmeasured"} jsonBytes=${run.jsonBytes} evidenceBytes=${run.evidenceBytes}`);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}

const report = evaluatePerformanceGate({ runs, thresholds });
console.log(JSON.stringify(report, null, 2));
process.exit(report.passed ? 0 : 1);
