#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { analyzeSource, type AnalyzeOptions } from "./core/analyze.js";
import { deliveryExitCode } from "./core/architecture/scope.js";

const usage = `RepoMap — evidence-backed repository architecture diagrams

Usage:
  repomap analyze <source> [options]

Source:
  owner/repo[@40-char-SHA]
  https://github.com/owner/repo[/tree/40-char-SHA]
  /path/to/local/repository (requires --revision)

Options:
  --revision <sha>   Pin a 40-character Git revision
  --out <directory>  Output directory (default: ./repomap-output/<repo>-<short-sha>)
  --locale <locale>  en (default) or zh-CN
  --view <view>      Request a view: system|runtime|module|flows|full (repeatable; default runtime)
  --include <glob>   Declare an included path (repeatable)
  --exclude <glob>   Declare a user-excluded path as out-of-scope (repeatable)
  --require-external-hosts   Require resolvable external hosts (strict full gate)
  --no-render        Write JSON, coverage and receipt only; no Archify or Chromium
  --visual-check     Run Archify Chromium visual checks after delivery
  --no-cache         Disable the local GitHub archive cache
  -h, --help         Show this help
  -v, --version      Show the package version

A runtime overview is not a complete architecture. Only a passing
full-declared-scope gate can set fullArchitecture; default runtime receipts
keep it false. Full is per-input semantic completeness, not release qualification.

Environment:
  GITHUB_TOKEN       Optional token for private repositories and higher API limits
  REPOMAP_CACHE_DIR  Archive cache directory (default: ~/.repomap/cache)
  ARCHIFY_CHROME     Optional Chromium executable for --visual-check
`;

export function parseCliArguments(argv: string[]): AnalyzeOptions | { help: true } | { version: true } {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) return { help: true };
  if (argv.includes("--version") || argv.includes("-v")) return { version: true };
  if (argv[0] !== "analyze") throw new Error("Expected the analyze command");
  const source = argv[1];
  if (!source || source.startsWith("-")) throw new Error("The analyze command requires a repository source");
  const options: AnalyzeOptions = { source };
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--no-render") { options.render = false; continue; }
    if (argument === "--visual-check") { options.visualCheck = true; continue; }
    if (argument === "--no-cache") { options.useCache = false; continue; }
    if (argument === "--require-external-hosts") { options.strictExternalHosts = true; continue; }
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) throw new Error(`Missing value for ${argument}`);
    index += 1;
    if (argument === "--revision") { options.revision = value; continue; }
    if (argument === "--out") { options.outDir = value; continue; }
    if (argument === "--locale") {
      if (value !== "en" && value !== "zh-CN") throw new Error("--locale must be en or zh-CN");
      options.locale = value;
      continue;
    }
    if (argument === "--view") {
      options.requestedViews = [...(options.requestedViews ?? []), value];
      continue;
    }
    if (argument === "--include") {
      options.include = [...(options.include ?? []), value];
      continue;
    }
    if (argument === "--exclude") {
      options.exclude = [...(options.exclude ?? []), value];
      options.userExclusions = [...(options.userExclusions ?? []), value];
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseCliArguments(argv);
  if ("help" in parsed) { console.log(usage); return; }
  if ("version" in parsed) {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    console.log(packageJson.version);
    return;
  }
  const receipt = await analyzeSource(parsed);
  console.log(JSON.stringify(receipt, null, 2));
  if (receipt.status === "failed" || deliveryExitCode(receipt.delivery) !== 0) {
    console.error(`RepoMap failed: ${receipt.status === "failed" ? receipt.error : "one or more requested views failed"}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error) => {
    console.error(`RepoMap failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
