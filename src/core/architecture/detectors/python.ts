import { posix } from "node:path";
import { findArchitectureEvidence, architectureLineNumber, type ArchitectureSource } from "../source.js";
import { pythonCodeLines, pythonMainGuardLine } from "../project/python-source.js";
import type { NodeFact } from "../facts.js";
import { actorNode, emptyArchitectureFragment, factEdge, type ArchitectureContext, type ArchitectureDetector, type ArchitectureFragment } from "./types.js";

function unitFor(source: ArchitectureSource) {
  const directory = posix.dirname(source.path);
  return directory === "." ? "root" : directory;
}

function sourcePaths(sources: ArchitectureSource[], unit: string, childUnits: string[]) {
  const prefix = unit === "root" ? "" : `${unit}/`;
  const childPrefixes = childUnits.filter((child) => child !== unit && (unit === "root" || child.startsWith(`${unit}/`))).map((child) => `${child}/`);
  return sources.filter((candidate) => candidate.path.endsWith(".py") && (prefix === "" || candidate.path.startsWith(prefix)) && !childPrefixes.some((child) => candidate.path.startsWith(child))).map((candidate) => candidate.path).sort();
}

function entryEvidence(source: ArchitectureSource) {
  const guardLine = pythonMainGuardLine(source.content);
  if (guardLine >= 0) return { path: source.path, line: architectureLineNumber(source.content.split("\n")[guardLine], guardLine), detector: "python-main-guard" };
  if (source.path.endsWith("__main__.py") && source.content.trim().length > 0) return { path: source.path, line: 1, detector: "python-main-module" };
  if (/(?:^|\/)(?:wsgi|asgi)\.py$/.test(source.path) && source.content.trim().length > 0) return { path: source.path, line: 1, detector: "python-web-entrypoint" };
  if (/(?:FastAPI|Flask)\s*\(/.test(pythonCodeLines(source.content).join("\n"))) return findArchitectureEvidence({ ...source, content: pythonCodeLines(source.content).join("\n") }, ["FastAPI", "Flask"], "python-web-entrypoint");
  return undefined;
}

function detectPython(context: ArchitectureContext): ArchitectureFragment {
  const fragment = emptyArchitectureFragment();
  const entries = context.sources.filter((source) => source.path.endsWith(".py") && (source.path.endsWith("__main__.py") || /(?:^|\/)(?:wsgi|asgi)\.py$/.test(source.path) || /(?:FastAPI|Flask)\s*\(/.test(pythonCodeLines(source.content).join("\n")) || pythonMainGuardLine(source.content) >= 0));
  const entriesByUnit = new Map<string, ArchitectureSource[]>();
  for (const source of entries) {
    const unit = unitFor(source);
    entriesByUnit.set(unit, [...(entriesByUnit.get(unit) ?? []), source]);
  }
  const units = [...entriesByUnit.keys()].sort();
  for (const unit of units) {
    const unitEntries = entriesByUnit.get(unit) ?? [];
    const evidence = unitEntries.map(entryEvidence).filter((item): item is NonNullable<typeof item> => Boolean(item));
    if (evidence.length === 0) continue;
    const paths = sourcePaths(context.sources, unit, units);
    const id = `python:${unit}`;
    const signalIds = context.signals.filter((signal) => ["entrypoint", "deployable", "worker"].includes(signal.kind) && paths.includes(signal.evidence.path)).map((signal) => signal.id).sort();
    const serverEvidence = context.sources.filter((candidate) => paths.includes(candidate.path)).flatMap((candidate) => {
      const found = findArchitectureEvidence({ ...candidate, content: candidate.path.endsWith(".py") ? pythonCodeLines(candidate.content).join("\n") : candidate.content }, ["Flask", "FastAPI", "Django", "HTTPServer", "uvicorn.run", "app.run", "wsgi", "asgi"], "python-http-entrypoint");
      return found ? [found] : [];
    })[0];
    const kind: NodeFact["kind"] = serverEvidence ? "api" : "cli";
    const node: NodeFact = {
      id,
      kind,
      label: `Python ${posix.basename(unit)}`,
      runtimeUnit: unit,
      sourcePaths: paths,
      signalIds,
      evidence,
    };
    fragment.nodes.push(node);
    if (serverEvidence) {
      fragment.nodes.push(actorNode("actor:users", "产品用户"));
      fragment.roots.push("actor:users");
      fragment.edges.push(factEdge(`entry:users->${id}`, "actor:users", id, "http", "Python HTTP 入口", [serverEvidence], signalIds));
    } else {
      fragment.nodes.push(actorNode("actor:cli-users", "命令行用户"));
      fragment.roots.push("actor:cli-users");
      fragment.edges.push(factEdge(`entry:cli-users->${id}`, "actor:cli-users", id, "process", "Python 命令行入口", [evidence[0]], signalIds));
    }
  }
  return fragment;
}

export const pythonArchitectureDetector: ArchitectureDetector = { id: "python-runtime-entrypoints", detect: detectPython };
