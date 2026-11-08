import { posix } from "node:path";
import { findArchitectureEvidence, type ArchitectureSource } from "../source.js";
import type { NodeFact } from "../facts.js";
import { actorNode, emptyArchitectureFragment, factEdge, type ArchitectureContext, type ArchitectureDetector, type ArchitectureFragment } from "./types.js";

function goUnit(source: ArchitectureSource) {
  const unit = posix.dirname(source.path);
  return unit === "." ? "main" : unit;
}

function sourceDirectory(path: string) {
  return posix.dirname(path);
}

function importCandidates(value: string, modules: string[]) {
  const module = modules.find((name) => value === name || value.startsWith(`${name}/`));
  if (module === undefined) return [];
  return value === module ? [""] : [value.slice(module.length + 1)];
}

function pathSuffix(directory: string, candidate: string) {
  if (candidate === "") return directory === ".";
  const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|/)${escaped}$`).test(directory);
}

function importedDirectories(source: ArchitectureSource, directories: string[], modules: string[]) {
  const imports = [...source.content.matchAll(/"([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_./-]+)"/g)].map((match) => match[1]);
  const candidates = imports.flatMap((value) => importCandidates(value, modules));
  return directories.filter((directory) => imports.some((value) => value.split("/")[0].includes(".")) && candidates.some((candidate) => pathSuffix(directory, candidate)));
}

function directoryImports(current: string, sourcesByDirectory: Map<string, ArchitectureSource[]>, directories: string[], modules: string[], visited: Set<string>) {
  return sourcesByDirectory.get(current)!
    .flatMap((source) => importedDirectories(source, directories, modules))
    .filter((imported) => !visited.has(imported));
}

function groupSourcesByDirectory(goSources: ArchitectureSource[]) {
  const grouped = new Map<string, ArchitectureSource[]>();
  for (const source of goSources) {
    const directory = sourceDirectory(source.path);
    if (!grouped.has(directory)) grouped.set(directory, []);
    grouped.get(directory)!.push(source);
  }
  return grouped;
}

function goSourcePaths(main: ArchitectureSource, sources: ArchitectureSource[]) {
  const goSources = sources.filter((source) => source.path.endsWith(".go"));
  const sourcesByDirectory = groupSourcesByDirectory(goSources);
  const modules = sources.filter((source) => source.path.endsWith("go.mod")).flatMap((source) => [...source.content.replace(/^\s*\d+:\s?/gm, "").matchAll(/(?:^|\n)\s*module\s+([^\s]+)/g)].map((match) => match[1]));
  const directories = [...new Set(goSources.map((source) => sourceDirectory(source.path)))];
  const pending = [sourceDirectory(main.path)];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.shift() as string;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const imported of directoryImports(current, sourcesByDirectory, directories, modules, visited)) {
      pending.push(imported);
    }
  }
  return goSources.filter((source) => visited.has(sourceDirectory(source.path))).map((source) => source.path).sort();
}

function goKind(source: ArchitectureSource): NodeFact["kind"] {
  if (/agent/i.test(source.path)) return "agent";
  if (/worker|job|scheduler/i.test(source.path)) return "worker";
  return "api";
}

function goNode(source: ArchitectureSource, context: ArchitectureContext, evidence: NonNullable<ReturnType<typeof findArchitectureEvidence>>): NodeFact {
  const unit = goUnit(source);
  const sourcePaths = goSourcePaths(source, context.sources);
  const paths = new Set(sourcePaths);
  const signalIds = context.signals.filter((signal) => ["entrypoint", "deployable", "worker"].includes(signal.kind) && paths.has(signal.evidence.path)).map((signal) => signal.id).sort();
  return { id: `go:${unit}`, kind: goKind(source), label: `Go ${posix.basename(unit)}`, runtimeUnit: posix.basename(unit), sourcePaths, signalIds, evidence: [evidence] };
}

function detectGo(context: ArchitectureContext): ArchitectureFragment {
  const fragment = emptyArchitectureFragment();
  const mains = context.sources.filter((source) => /(?:^|\/)main\.go$/.test(source.path));
  for (const source of mains) {
    const mainEvidence = findArchitectureEvidence(source, ["func main"], "go-process-entrypoint");
    if (!mainEvidence) continue;
    const node = goNode(source, context, mainEvidence);
    fragment.nodes.push(node);
    const serverEvidence = context.sources.filter((source) => node.sourcePaths?.includes(source.path)).flatMap((source) => {
      const evidence = findArchitectureEvidence(source, ["ListenAndServe", "NewHandler", "http.Handle", "chi.NewRouter", "mux.NewRouter", "gin.Default", "echo.New", "http.Serve", "Serve(", "service.RunAll"], "go-http-entrypoint");
      return evidence ? [evidence] : [];
    })[0];
    const serverRoot = serverEvidence && node.kind === "api";
    if (serverRoot) {
      fragment.nodes.push(actorNode("actor:users", "产品用户"));
      fragment.roots.push("actor:users");
      fragment.edges.push(factEdge(`entry:users->${node.id}`, "actor:users", node.id, "http", "HTTP 服务入口", [serverEvidence], node.signalIds));
    }
    const scheduleEvidence = findArchitectureEvidence(source, ["NewRunner", "for {", "time.Tick", "POLL_INTERVAL", "render-tasks"], "go-async-entrypoint");
    const asyncRoot = scheduleEvidence && (node.kind === "worker" || node.kind === "agent");
    if (asyncRoot) {
      fragment.nodes.push(actorNode("actor:scheduler", "调度器 / 轮询"));
      fragment.roots.push("actor:scheduler");
      fragment.edges.push(factEdge(`entry:scheduler->${node.id}`, "actor:scheduler", node.id, "schedule", "异步任务入口", [scheduleEvidence], node.signalIds));
    }
    if (!serverRoot && !asyncRoot) {
      node.kind = "cli";
      fragment.nodes.push(actorNode("actor:cli-users", "命令行用户"));
      fragment.roots.push("actor:cli-users");
      fragment.edges.push(factEdge(`entry:cli-users->${node.id}`, "actor:cli-users", node.id, "process", "命令行入口", [mainEvidence], node.signalIds));
    }
  }
  return fragment;
}

export const goArchitectureDetector: ArchitectureDetector = { id: "go-runtime-entrypoints", detect: detectGo };
