#!/usr/bin/env node
/**
 * Production-install smoke test (plan 7.4).
 *
 * Packs the CLI, installs ONLY the tarball's production dependencies into an
 * isolated consumer, then runs the packed CLI against a fixed-SHA fixture.
 * This proves the TypeScript Compiler API and the fixed Tree-sitter Go WASM
 * grammar are real runtime dependencies, and that the packed CLI still emits
 * architecture.project.json plus architecture.go-module-graph.json.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const scratch = join(root, ".repomap");
await mkdir(scratch, { recursive: true });
const work = await mkdtemp(join(scratch, "smoke-"));
const consumer = join(work, "consumer");
const fixture = join(work, "fixture");
const out = join(work, "out");
let ok = false;

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
}

try {
  const packed = run("npm", ["pack", "--json", "--pack-destination", work]);
  const start = packed.indexOf("[");
  const end = packed.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error(`npm pack did not return JSON: ${packed.slice(0, 200)}`);
  const artifact = JSON.parse(packed.slice(start, end + 1))[0];
  if (!artifact?.filename) throw new Error("npm pack did not report a tarball filename");
  const tarball = join(work, artifact.filename);

  run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--prefix", consumer, tarball]);
  const cli = join(consumer, "node_modules", "repomap", "dist", "cli.js");
  if (!existsSync(cli)) throw new Error(`packed CLI is missing: ${cli}`);
  const version = run("node", [cli, "--version"]).trim();

  await mkdir(join(fixture, "app/api/products"), { recursive: true });
  await writeFile(join(fixture, "package.json"), `${JSON.stringify({ name: "smoke-fixture", scripts: { start: "next start" }, dependencies: { next: "16.0.0" } })}\n`);
  await writeFile(join(fixture, "app/page.tsx"), "export default function Page() {}\n");
  await writeFile(join(fixture, "app/api/products/route.ts"), "export async function GET() {}\n");
  await writeFile(join(fixture, "go.mod"), "module example.com/smoke\n\ngo 1.22\n");
  await mkdir(join(fixture, "cmd/smoke"), { recursive: true });
  await writeFile(join(fixture, "cmd/smoke/main.go"), "package main\n\nimport \"fmt\"\n\nfunc main() { fmt.Println(\"ok\") }\n");
  run("git", ["-C", fixture, "init", "-q"]);
  run("git", ["-C", fixture, "config", "user.email", "smoke@example.test"]);
  run("git", ["-C", fixture, "config", "user.name", "smoke"]);
  run("git", ["-C", fixture, "add", "-A"]);
  run("git", ["-C", fixture, "commit", "-qm", "smoke fixture"]);
  const sha = run("git", ["-C", fixture, "rev-parse", "HEAD"]).trim();

  run("node", [cli, "analyze", fixture, "--revision", sha, "--no-render", "--out", out]);
  const receipt = JSON.parse(await readFile(join(out, "repomap.receipt.json"), "utf8"));
  const project = JSON.parse(await readFile(join(out, "architecture.project.json"), "utf8"));
  const goGraph = JSON.parse(await readFile(join(out, "architecture.go-module-graph.json"), "utf8"));
  if (receipt.status === "failed") throw new Error(`packed CLI analysis failed: ${receipt.error ?? "unknown"}`);
  if (!project.snapshotId) throw new Error("architecture.project.json has no snapshotId");
  const tsParser = project.parsers.find((parser) => parser.id === "ast-typescript");
  if (!tsParser || tsParser.status === "unavailable") throw new Error("packed CLI did not load the TypeScript parser");
  const goParser = project.parsers.find((parser) => parser.id === "ast-go");
  if (!goParser || goParser.status === "unavailable") throw new Error("packed CLI did not load the Go WASM grammar");
  if (goGraph.parser.status !== "available" || goGraph.nodes.length === 0) throw new Error("packed CLI did not build the Go package graph");
  if (!receipt.project || receipt.project.snapshotId !== project.snapshotId) throw new Error("receipt and project snapshot IDs disagree");

  ok = true;
  console.log(JSON.stringify({
    ok: true,
    tarball: artifact.filename,
    cliVersion: version,
    status: receipt.status,
    parsers: project.parsers,
    units: project.statistics.units,
    imports: project.statistics.imports,
    goPackages: goGraph.statistics.packages,
    goParser: goGraph.parser,
    snapshotId: project.snapshotId,
  }, null, 2));
} finally {
  try {
    await rm(work, { recursive: true, force: true });
  } catch (error) {
    console.warn(`[smoke] best-effort cleanup left ${work} in place: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!ok) process.exitCode = 1;
}
