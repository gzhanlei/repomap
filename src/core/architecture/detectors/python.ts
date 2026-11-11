import { posix } from "node:path";
import { findArchitectureEvidence, architectureLineNumber, type ArchitectureSource } from "../source.js";
import { pythonMainGuardLine } from "../project/python-source.js";
import type { NodeFact } from "../facts.js";
import { actorNode, emptyArchitectureFragment, factEdge, type ArchitectureContext, type ArchitectureDetector, type ArchitectureFragment } from "./types.js";

function unitFor(source: ArchitectureSource) {
  const directory = posix.dirname(source.path);
  return directory === "." ? "root" : directory;
}

function sourcePaths(source: ArchitectureSource, sources: ArchitectureSource[], unit: string) {
  const prefix = unit === "root" ? "" : `${unit}/`;
  return sources.filter((candidate) => candidate.path.endsWith(".py") && (prefix === "" || candidate.path.startsWith(prefix))).map((candidate) => candidate.path).sort();
}

function entryEvidence(source: ArchitectureSource) {
  const guardLine = pythonMainGuardLine(source.content);
  if (guardLine >= 0) return { path: source.path, line: architectureLineNumber(source.content.split("\n")[guardLine], guardLine), detector: "python-main-guard" };
  if (source.path.endsWith("__main__.py") && source.content.trim().length > 0) return { path: source.path, line: 1, detector: "python-main-module" };
  if (/(?:^|\/)(?:wsgi|asgi)\.py$/.test(source.path) && source.content.trim().length > 0) return { path: source.path, line: 1, detector: "python-web-entrypoint" };
  return undefined;
}

function detectPython(context: ArchitectureContext): ArchitectureFragment {
  const fragment = emptyArchitectureFragment();
  const entries = context.sources.filter((source) => source.path.endsWith(".py") && (source.path.endsWith("__main__.py") || /(?:^|\/)(?:wsgi|asgi)\.py$/.test(source.path) || pythonMainGuardLine(source.content) >= 0));
  for (const source of entries) {
    const evidence = entryEvidence(source);
    if (!evidence) continue;
    const unit = unitFor(source);
    const paths = sourcePaths(source, context.sources, unit);
    const id = `python:${unit}`;
    const signalIds = context.signals.filter((signal) => ["entrypoint", "deployable", "worker"].includes(signal.kind) && paths.includes(signal.evidence.path)).map((signal) => signal.id).sort();
    const serverEvidence = context.sources.filter((candidate) => paths.includes(candidate.path)).flatMap((candidate) => {
      const found = findArchitectureEvidence(candidate, ["Flask", "FastAPI", "Django", "HTTPServer", "uvicorn.run", "app.run", "wsgi", "asgi"], "python-http-entrypoint");
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
      evidence: [evidence],
    };
    fragment.nodes.push(node);
    if (serverEvidence) {
      fragment.nodes.push(actorNode("actor:users", "产品用户"));
      fragment.roots.push("actor:users");
      fragment.edges.push(factEdge(`entry:users->${id}`, "actor:users", id, "http", "Python HTTP 入口", [serverEvidence], signalIds));
    } else {
      fragment.nodes.push(actorNode("actor:cli-users", "命令行用户"));
      fragment.roots.push("actor:cli-users");
      fragment.edges.push(factEdge(`entry:cli-users->${id}`, "actor:cli-users", id, "process", "Python 命令行入口", [evidence], signalIds));
    }
  }
  return fragment;
}

export const pythonArchitectureDetector: ArchitectureDetector = { id: "python-runtime-entrypoints", detect: detectPython };
